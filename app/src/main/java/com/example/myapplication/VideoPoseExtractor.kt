package com.example.myapplication

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
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
    private var lastValidLandmarks: Map<Int, Point2D>? = null

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
        lastValidLandmarks = null
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

                            // 表示用に縮小した軽量プレビュー画像を生成
                            val targetW = 320
                            val targetH = max(1, (bitmap.height * (320f / bitmap.width)).toInt())
                            val scaled = Bitmap.createScaledBitmap(bitmap, targetW, targetH, true)
                            val finalPreview = if (isFrontCameraMirrored) {
                                val matrix = Matrix().apply { preScale(-1f, 1f) }
                                val mirrored = Bitmap.createBitmap(scaled, 0, 0, scaled.width, scaled.height, matrix, false)
                                if (mirrored != scaled) scaled.recycle()
                                mirrored
                            } else {
                                scaled
                            }

                            lastTimestampMs = timestampMs
                            val frameData = analyzeSingleBitmap(
                                bitmap = bitmap,
                                timestampMs = timestampMs,
                                isFrontCameraMirrored = isFrontCameraMirrored
                            )
                            if (frameData != null) {
                                results.add(frameData.copy(previewBitmap = finalPreview))
                            } else {
                                finalPreview.recycle()
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

        var lShoulder = lmMap[11]
        var rShoulder = lmMap[12]
        var lHip = lmMap[23]
        var rHip = lmMap[24]

        // 過去の有効なフレーム情報があれば欠損関節を補間（横向きや遮蔽への対策）
        val prevLm = lastValidLandmarks
        if (prevLm != null) {
            if (lShoulder == null) lShoulder = prevLm[11]
            if (rShoulder == null) rShoulder = prevLm[12]
            if (lHip == null) lHip = prevLm[23]
            if (rHip == null) rHip = prevLm[24]
        }

        // 片側の肩・腰が欠損している（完全に横向き）場合でも検出できている側から推定
        val effectiveMidShoulderX: Float
        val effectiveMidShoulderY: Float
        if (lShoulder != null && rShoulder != null) {
            effectiveMidShoulderX = (lShoulder.x + rShoulder.x) / 2f
            effectiveMidShoulderY = (lShoulder.y + rShoulder.y) / 2f
        } else if (lShoulder != null) {
            effectiveMidShoulderX = lShoulder.x
            effectiveMidShoulderY = lShoulder.y
            lmMap[12] = lShoulder
        } else if (rShoulder != null) {
            effectiveMidShoulderX = rShoulder.x
            effectiveMidShoulderY = rShoulder.y
            lmMap[11] = rShoulder
        } else {
            val nose = lmMap[0] ?: prevLm?.get(0)
            if (nose != null) {
                effectiveMidShoulderX = nose.x
                effectiveMidShoulderY = (nose.y + 0.15f).coerceIn(0f, 1f)
            } else {
                return null
            }
        }

        val effectiveMidHipX: Float
        val effectiveMidHipY: Float
        if (lHip != null && rHip != null) {
            effectiveMidHipX = (lHip.x + rHip.x) / 2f
            effectiveMidHipY = (lHip.y + rHip.y) / 2f
        } else if (lHip != null) {
            effectiveMidHipX = lHip.x
            effectiveMidHipY = lHip.y
            lmMap[24] = lHip
        } else if (rHip != null) {
            effectiveMidHipX = rHip.x
            effectiveMidHipY = rHip.y
            lmMap[23] = rHip
        } else {
            effectiveMidHipX = effectiveMidShoulderX
            effectiveMidHipY = (effectiveMidShoulderY + 0.25f).coerceIn(0f, 1f)
        }

        val lFootX = averageX(lmMap[27], lmMap[29], lmMap[31]) ?: prevLm?.let { averageX(it[27], it[29], it[31]) } ?: effectiveMidHipX
        val rFootX = averageX(lmMap[28], lmMap[30], lmMap[32]) ?: prevLm?.let { averageX(it[28], it[30], it[32]) } ?: effectiveMidHipX

        val midBaseX = (lFootX + rFootX) / 2f
        val pelvisWidth = abs((lHip?.x ?: effectiveMidHipX) - (rHip?.x ?: effectiveMidHipX))
        val minGuardWidth = max(0.06f, pelvisWidth * 0.8f)
        val baseWidth = max(abs(lFootX - rFootX), minGuardWidth)

        val midFootX = (lFootX + rFootX) / 2f
        val comX = 0.30f * effectiveMidShoulderX + 0.40f * effectiveMidHipX + 0.30f * midFootX

        val lFootY = averageY(lmMap[27], lmMap[29], lmMap[31]) ?: prevLm?.let { averageY(it[27], it[29], it[31]) } ?: (effectiveMidHipY + 0.30f).coerceIn(0f, 1f)
        val rFootY = averageY(lmMap[28], lmMap[30], lmMap[32]) ?: prevLm?.let { averageY(it[28], it[30], it[32]) } ?: (effectiveMidHipY + 0.30f).coerceIn(0f, 1f)
        val midFootY = (lFootY + rFootY) / 2f
        val comY = 0.30f * effectiveMidShoulderY + 0.40f * effectiveMidHipY + 0.30f * midFootY

        val signedShiftFromMid = if (isFrontCameraMirrored) {
            midBaseX - comX
        } else {
            comX - midBaseX
        }

        val leftBias = (50f + (signedShiftFromMid / baseWidth) * 100f).coerceIn(0f, 100f)
        val rightBias = 100f - leftBias

        lastValidLandmarks = lmMap.toMap()

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
