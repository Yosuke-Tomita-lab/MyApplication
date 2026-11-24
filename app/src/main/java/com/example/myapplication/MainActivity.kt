package com.example.myapplication

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max

class StsViewModel : ViewModel() {
    var showCamera by mutableStateOf(false)
    var selectedMode by mutableStateOf(StsMode.SINGLE)
    var heightInput by mutableStateOf("170")
    var weightInput by mutableStateOf("65")
    var isMirrored by mutableStateOf(false)
    var isAnalyzing by mutableStateOf(false)
    var progress by mutableFloatStateOf(0f)
    var errorMessage by mutableStateOf<String?>(null)
    var analysisResult by mutableStateOf<StsAnalysisResult?>(null)
    var selectedRepIndex by mutableIntStateOf(0)
    var pendingCsvContent by mutableStateOf<String?>(null)

    fun currentAnthropometrics() = SubjectAnthropometrics(
        heightCm = heightInput.toFloatOrNull()?.coerceIn(100f, 240f) ?: 170f,
        weightKg = weightInput.toFloatOrNull()?.coerceIn(20f, 250f) ?: 65f
    )

    fun runOfflineAnalysis(context: Context, uri: Uri) {
        showCamera = false
        val anthro = currentAnthropometrics()
        viewModelScope.launch {
            isAnalyzing = true
            errorMessage = null
            progress = 0f
            val extractor = VideoPoseExtractor(context)
            try {
                val rawFrames = extractor.extractFrames(
                    videoUri = uri,
                    isFrontCameraMirrored = isMirrored,
                    onProgress = { p -> progress = p }
                )
                val res = StsMetricCalculator.calculate(
                    rawFrames = rawFrames,
                    mode = selectedMode,
                    anthropometrics = anthro,
                    isFrontCameraMirrored = isMirrored
                )
                analysisResult = res.copy(videoUri = uri)
                selectedRepIndex = 0
            } catch (e: Exception) {
                errorMessage = e.message ?: "解析中にエラーが発生しました。"
            } finally {
                extractor.close()
                isAnalyzing = false
            }
        }
    }
}

class MainActivity : ComponentActivity() {
    private val viewModel: StsViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                StsMainApp(viewModel)
            }
        }
    }
}

@Composable
fun StsMainApp(viewModel: StsViewModel) {
    val context = LocalContext.current

    var showCamera by viewModel::showCamera
    var selectedMode by viewModel::selectedMode
    var heightInput by viewModel::heightInput
    var weightInput by viewModel::weightInput
    var isMirrored by viewModel::isMirrored
    val isAnalyzing by viewModel::isAnalyzing
    val progress by viewModel::progress
    val errorMessage by viewModel::errorMessage
    var analysisResult by viewModel::analysisResult
    var selectedRepIndex by viewModel::selectedRepIndex
    var pendingCsvContent by viewModel::pendingCsvContent

    val createCsvLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("text/csv")
    ) { uri: Uri? ->
        val csv = pendingCsvContent
        if (uri != null && csv != null) {
            val success = StsCsvExporter.saveCsvToUri(context, uri, csv)
            if (success) {
                Toast.makeText(context, "CSVファイルを保存しました", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(context, "CSVの保存に失敗しました", Toast.LENGTH_SHORT).show()
            }
        }
    }

    val videoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) viewModel.runOfflineAnalysis(context, uri)
    }

    if (showCamera) {
        StsCameraCaptureScreen(
            modeLabel = selectedMode.label,
            onVideoRecorded = { uri -> viewModel.runOfflineAnalysis(context, uri) },
            onCancel = { showCamera = false }
        )
        return
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text(
                text = "立ち座り動作解析（Android / オフライン）",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StsMode.entries.forEach { mode ->
                    FilterChip(
                        selected = selectedMode == mode,
                        onClick = { selectedMode = mode },
                        label = { Text(mode.label) }
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    value = heightInput,
                    onValueChange = { heightInput = it },
                    label = { Text("身長 (cm)") },
                    singleLine = true,
                    modifier = Modifier.weight(1f)
                )
                OutlinedTextField(
                    value = weightInput,
                    onValueChange = { weightInput = it },
                    label = { Text("体重 (kg)") },
                    singleLine = true,
                    modifier = Modifier.weight(1f)
                )
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = isMirrored, onCheckedChange = { isMirrored = it })
                Text("鏡像反転（フロントカメラ等）", style = MaterialTheme.typography.bodyMedium)
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Button(
                    onClick = { showCamera = true },
                    enabled = !isAnalyzing,
                    modifier = Modifier.weight(1f)
                ) {
                    Text("正面全身で撮影")
                }
                OutlinedButton(
                    onClick = { videoPickerLauncher.launch("video/*") },
                    enabled = !isAnalyzing,
                    modifier = Modifier.weight(1f)
                ) {
                    Text("動画を選択")
                }
            }
        }

        if (isAnalyzing) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    LinearProgressIndicator(
                        progress = { progress },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Text("オフライン解析中: ${(progress * 100).toInt()}%")
                }
            }
        }

        errorMessage?.let { msg ->
            item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                    Text(
                        text = msg,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.padding(12.dp)
                    )
                }
            }
        }

        analysisResult?.let { result ->
            if (result.overallTotalDurationSec != null) {
                item {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(14.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text("5回立ち座り 全体所要時間", style = MaterialTheme.typography.labelLarge)
                            Text(
                                text = String.format(Locale.US, "%.2f 秒", result.overallTotalDurationSec),
                                style = MaterialTheme.typography.headlineMedium,
                                fontWeight = FontWeight.Bold
                            )

                            // 試行成績（総試行数・成功数・失敗数・確率）
                            HorizontalDivider()
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text("総試行: ${result.totalAttempts}回", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                                Text("成功: ${result.successCount}回 (${String.format(Locale.US, "%.1f%%", result.successRatePercent)})", style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    text = "失敗: ${result.failureCount}回 (${String.format(Locale.US, "%.1f%%", result.failureRatePercent)})",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = if (result.failureCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                                )
                            }
                            if (result.failedAttempts.isNotEmpty()) {
                                Text(
                                    text = "離臀失敗時刻: " + result.failedAttempts.joinToString(", ") { String.format(Locale.US, "%.2fs", it.timestampMs / 1000f) },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error
                                )
                            }

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                val dateTag = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                                val filename = "STS_5xSTS_AllReps_$dateTag.csv"
                                OutlinedButton(
                                    onClick = {
                                        pendingCsvContent = StsCsvExporter.generateCsv(result)
                                        createCsvLauncher.launch(filename)
                                    },
                                    modifier = Modifier.weight(1f)
                                ) {
                                    Text("全体CSV保存")
                                }
                                FilledTonalButton(
                                    onClick = {
                                        val content = StsCsvExporter.generateCsv(result)
                                        StsCsvExporter.shareCsv(context, filename, content)
                                    },
                                    modifier = Modifier.weight(1f)
                                ) {
                                    Text("全体CSV共有")
                                }
                            }
                        }
                    }
                }
            }

            if (result.overallTotalDurationSec == null && result.failedAttempts.isNotEmpty()) {
                item {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("試行成績（総合）", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("総試行: ${result.totalAttempts}回", fontWeight = FontWeight.SemiBold)
                                Text("成功: ${result.successCount}回 (${String.format(Locale.US, "%.1f%%", result.successRatePercent)})")
                                Text(
                                    text = "失敗: ${result.failureCount}回 (${String.format(Locale.US, "%.1f%%", result.failureRatePercent)})",
                                    color = MaterialTheme.colorScheme.error
                                )
                            }
                        }
                    }
                }
            }

            if (result.trials.size > 1) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        result.trials.forEachIndexed { idx, trial ->
                            FilterChip(
                                selected = selectedRepIndex == idx,
                                onClick = { selectedRepIndex = idx },
                                label = { Text("${trial.repIndex}回目") }
                            )
                        }
                    }
                }
            }

            val currentTrial = result.trials.getOrNull(selectedRepIndex) ?: result.trials.firstOrNull()
            if (currentTrial != null) {
                item {
                    TimeSummaryCard(trial = currentTrial)
                }
                item {
                    BiasSummaryCard(trial = currentTrial)
                }
                item {
                    EstimatedGrfCard(trial = currentTrial)
                }
                item {
                    PoseEventOverlayCard(
                        frames = result.frames,
                        trial = currentTrial,
                        videoUri = result.videoUri,
                        analysisResult = result,
                        onTrialUpdated = { updatedTrial ->
                            val updatedTrials = result.trials.map {
                                if (it.repIndex == updatedTrial.repIndex) updatedTrial else it
                            }
                            val updatedOverallSec = if (result.mode == StsMode.FIVE_TIMES && updatedTrials.size >= 5) {
                                max(0f, (updatedTrials[4].stableTimeMs - updatedTrials.first().startTimeMs) / 1000f)
                            } else {
                                result.overallTotalDurationSec
                            }
                            analysisResult = result.copy(
                                trials = updatedTrials,
                                overallTotalDurationSec = updatedOverallSec
                            )
                        },
                        onFailedAttemptsUpdated = { updatedFails ->
                            analysisResult = result.copy(failedAttempts = updatedFails)
                        },
                        onRequestSaveCsv = { filename, content ->
                            pendingCsvContent = content
                            createCsvLauncher.launch(filename)
                        }
                    )
                }
            }

            if (result.trials.size > 1) {
                item {
                    Text("1〜5回目 比較", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                }
                items(result.trials) { trial ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text("${trial.repIndex}回目", fontWeight = FontWeight.Bold)
                            Text(String.format(Locale.US, "総 %.2fs", trial.totalDurationSec))
                            Text(
                                String.format(
                                    Locale.US,
                                    "平均 左%.0f%%/右%.0f%%",
                                    trial.meanLeftBiasPercent,
                                    100f - trial.meanLeftBiasPercent
                                )
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TimeSummaryCard(trial: SingleTrialMetrics) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("時間指標（${trial.repIndex}回目）", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("総運動時間（開始〜安定）")
                Text(String.format(Locale.US, "%.2f 秒", trial.totalDurationSec), fontWeight = FontWeight.SemiBold)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("離臀時間（開始〜離臀）")
                Text(String.format(Locale.US, "%.2f 秒", trial.seatOffDurationSec), fontWeight = FontWeight.SemiBold)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("立ち上がり時間（離臀〜完了）")
                Text(String.format(Locale.US, "%.2f 秒", trial.risingDurationSec), fontWeight = FontWeight.SemiBold)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("立位安定時間（完了〜安定）")
                Text(String.format(Locale.US, "%.2f 秒", trial.stabilizationDurationSec), fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun BiasSummaryCard(trial: SingleTrialMetrics) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("左右重心偏倚（50%が正中）", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            listOf(
                "運動開始時" to trial.biasAtStart,
                "離臀時" to trial.biasAtSeatOff,
                "立ち上がり完了時" to trial.biasAtStandEnd,
                "立位安定時" to trial.biasAtStable
            ).forEach { (label, b) ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(label)
                    Text(
                        String.format(Locale.US, "左 %.1f%% / 右 %.1f%%", b.leftPercent, b.rightPercent),
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}

@Composable
private fun EstimatedGrfCard(trial: SingleTrialMetrics) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = "推定床反力（${trial.repIndex}回目・離臀〜安定区間）",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = "※2D骨格重心加速度からの近似推定値",
                style = MaterialTheme.typography.bodySmall
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("鉛直GRF ピーク（加速）")
                Text(
                    String.format(Locale.US, "%.1f%%BW / %.1f N", trial.peakVerticalBwPercent, trial.peakVerticalNewton),
                    fontWeight = FontWeight.SemiBold
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("鉛直GRF 最小（減速・抜重）")
                Text(
                    String.format(Locale.US, "%.1f%%BW / %.1f N", trial.minVerticalBwPercent, trial.minVerticalNewton),
                    fontWeight = FontWeight.SemiBold
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("左右GRF ピーク（左方向）")
                Text(
                    String.format(Locale.US, "%.1f%%BW / %.1f N", trial.peakLateralLeftBwPercent, trial.peakLateralLeftNewton),
                    fontWeight = FontWeight.SemiBold
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("左右GRF ピーク（右方向）")
                Text(
                    String.format(Locale.US, "%.1f%%BW / %.1f N", trial.peakLateralRightBwPercent, trial.peakLateralRightNewton),
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}
