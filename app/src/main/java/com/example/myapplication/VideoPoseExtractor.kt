package com.example.myapplication

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import kotlin.math.abs
import kotlin.math.max

class VideoPoseExtractor(
    private val context: Context,
    modelAssetPath: String = "pose_landmarker_full.task"
) {
    private val poseLandmarker: PoseLandmarker by lazy {
        val baseOptions = BaseOptions.builder()
            .setModelAssetPath(modelAssetPath)
            .build()
        val options = PoseLandmarker.PoseLandmarkerOptions.builder()
            .setBaseOptions(baseOptions)
            .setRunningMode(RunningMode.VIDEO)
            .setNumPoses(1)
            .setMinPoseDetectionConfidence(0.5f)
            .setMinPosePresenceConfidence(0.5f)
            .setMinTrackingConfidence(0.5f)
            .build()
        PoseLandmarker.createFromOptions(context, options)
    }

    suspend fun extractFrames(
        videoUri: Uri,
        isFrontCameraMirrored: Boolean = false,
        onProgress: (Float) -> Unit = {}
    ): List<PoseFrameData> = withContext(Dispatchers.Default) {
        val extractor = MediaExtractor()
        val results = mutableListOf<PoseFrameData>()

        try {
            extractor.setDataSource(context, videoUri, null)
            val videoTrackIndex = findVideoTrack(extractor)
                ?: throw IllegalArgumentException("動画トラックが見つかりません。")

            extractor.selectTrack(videoTrackIndex)
            val format = extractor.getTrackFormat(videoTrackIndex)
            val mime = format.getString(MediaFormat.KEY_MIME)
                ?: throw IllegalArgumentException("動画MIMEタイプが不明です。")
            val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION)
            } else {
                0L
            }

            val decoder = MediaCodec.createDecoderByType(mime)
            decoder.configure(format, null, null, 0)
            decoder.start()

            val bufferInfo = MediaCodec.BufferInfo()
            var inputDone = false
            var outputDone = false
            var lastTimestampMs = -1L

            while (!outputDone) {
                ensureActive()

                if (!inputDone) {
                    val inputIndex = decoder.dequeueInputBuffer(10_000L)
                    if (inputIndex >= 0) {
                        val inputBuffer = decoder.getInputBuffer(inputIndex)!!
                        val sampleSize = extractor.readSampleData(inputBuffer, 0)
                        if (sampleSize < 0) {
                            decoder.queueInputBuffer(
                                inputIndex, 0, 0, 0L,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM
                            )
                            inputDone = true
                        } else {
                            val sampleTimeUs = extractor.sampleTime
                            decoder.queueInputBuffer(
                                inputIndex, 0, sampleSize, sampleTimeUs, 0
                            )
                            extractor.advance()
                        }
                    }
                }

                val outputIndex = decoder.dequeueOutputBuffer(bufferInfo, 10_000L)
                if (outputIndex >= 0) {
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                        outputDone = true
                    }

                    val timestampMs = max(0L, bufferInfo.presentationTimeUs / 1000L)
                    val shouldProcess = (bufferInfo.size > 0) && (timestampMs > lastTimestampMs)

                    if (shouldProcess) {
                        val image = decoder.getOutputImage(outputIndex)
                        if (image != null) {
                            val bitmap = image.toBitmap()
                            image.close()

                            lastTimestampMs = timestampMs
                            val frameData = analyzeSingleBitmap(
                                bitmap = bitmap,
                                timestampMs = timestampMs,
                                isFrontCameraMirrored = isFrontCameraMirrored
                            )
                            if (frameData != null) {
                                results.add(frameData)
                            }
                            bitmap.recycle()

                            if (durationUs > 0L) {
                                onProgress((bufferInfo.presentationTimeUs.toFloat() / durationUs).coerceIn(0f, 1f))
                            }
                        }
                    }
                    decoder.releaseOutputBuffer(outputIndex, false)
                }
            }

            decoder.stop()
            decoder.release()
            onProgress(1f)
            results
        } finally {
            try {
                extractor.release()
            } catch (_: IOException) {
            }
        }
    }

    private fun analyzeSingleBitmap(
        bitmap: Bitmap,
        timestampMs: Long,
        isFrontCameraMirrored: Boolean
    ): PoseFrameData? {
        val mpImage = BitmapImageBuilder(bitmap).build()
        val detectionResult = poseLandmarker.detectForVideo(mpImage, timestampMs)
        val firstPose = detectionResult.landmarks().firstOrNull() ?: return null

        val lmMap = mutableMapOf<Int, Point2D>()
        firstPose.forEachIndexed { index, normalizedLandmark ->
            lmMap[index] = Point2D(
                x = normalizedLandmark.x().coerceIn(0f, 1f),
                y = normalizedLandmark.y().coerceIn(0f, 1f)
            )
        }

        val lShoulder = lmMap[11] ?: return null
        val rShoulder = lmMap[12] ?: return null
        val lHip = lmMap[23] ?: return null
        val rHip = lmMap[24] ?: return null

        val lFootX = averageX(lmMap[27], lmMap[29], lmMap[31]) ?: lHip.x
        val rFootX = averageX(lmMap[28], lmMap[30], lmMap[32]) ?: rHip.x

        val midBaseX = (lFootX + rFootX) / 2f
        val pelvisWidth = abs(lHip.x - rHip.x)
        val minGuardWidth = max(0.06f, pelvisWidth * 0.8f)
        val baseWidth = max(abs(lFootX - rFootX), minGuardWidth)

        val midShoulderX = (lShoulder.x + rShoulder.x) / 2f
        val midHipX = (lHip.x + rHip.x) / 2f
        val midFootX = (lFootX + rFootX) / 2f
        val comX = 0.30f * midShoulderX + 0.40f * midHipX + 0.30f * midFootX

        val midShoulderY = (lShoulder.y + rShoulder.y) / 2f
        val midHipY = (lHip.y + rHip.y) / 2f
        val lFootY = averageY(lmMap[27], lmMap[29], lmMap[31]) ?: lHip.y
        val rFootY = averageY(lmMap[28], lmMap[30], lmMap[32]) ?: rHip.y
        val midFootY = (lFootY + rFootY) / 2f
        val comY = 0.30f * midShoulderY + 0.40f * midHipY + 0.30f * midFootY

        val signedShiftFromMid = if (isFrontCameraMirrored) {
            midBaseX - comX
        } else {
            comX - midBaseX
        }

        val leftBias = (50f + (signedShiftFromMid / baseWidth) * 100f).coerceIn(0f, 100f)
        val rightBias = 100f - leftBias

        return PoseFrameData(
            timestampMs = timestampMs,
            landmarks = lmMap,
            comX = comX,
            comY = comY,
            midBaseX = midBaseX,
            baseWidth = baseWidth,
            leftBiasPercent = leftBias,
            rightBiasPercent = rightBias
        )
    }

    private fun averageX(vararg pts: Point2D?): Float? {
        val valid = pts.filterNotNull()
        if (valid.isEmpty()) return null
        return valid.map { it.x }.average().toFloat()
    }

    private fun averageY(vararg pts: Point2D?): Float? {
        val valid = pts.filterNotNull()
        if (valid.isEmpty()) return null
        return valid.map { it.y }.average().toFloat()
    }

    private fun findVideoTrack(extractor: MediaExtractor): Int? {
        for (i in 0 until extractor.trackCount) {
            val format = extractor.getTrackFormat(i)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("video/")) return i
        }
        return null
    }

    fun close() {
        poseLandmarker.close()
    }
}

private fun Image.toBitmap(): Bitmap {
    val yBuffer = planes[0].buffer
    val uBuffer = planes[1].buffer
    val vBuffer = planes[2].buffer

    val ySize = yBuffer.remaining()
    val uSize = uBuffer.remaining()
    val vSize = vBuffer.remaining()

    val nv21 = ByteArray(ySize + uSize + vSize)
    yBuffer.get(nv21, 0, ySize)
    vBuffer.get(nv21, ySize, vSize)
    uBuffer.get(nv21, ySize + vSize, uSize)

    val yuvImage = YuvImage(nv21, ImageFormat.NV21, width, height, null)
    val out = ByteArrayOutputStream()
    yuvImage.compressToJpeg(Rect(0, 0, width, height), 85, out)
    val bytes = out.toByteArray()
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}
