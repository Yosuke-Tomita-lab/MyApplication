//
//  ARCaptureView.swift
//  STSAnalyzer
//
//  Created for iPad Pro LiDAR Sit-to-Stand Biomechanical Analysis
//

import SwiftUI
import ARKit

struct ARCaptureView: View {
    @ObservedObject var arManager: ARKitManager
    @Binding var selectedMode: String
    @Binding var currentTab: Int
    @Binding var latestJsonData: String?

    @State private var timerSeconds: Int = 0
    @State private var timer: Timer?

    var body: some View {
        ZStack {
            // 1. ARKit カメラプレビュー
            ARViewContainer(session: arManager.session)
                .edgesIgnoringSafeArea(.all)

            // 2. 被験者位置合わせガイド枠
            VStack {
                Spacer()
                RoundedRectangle(cornerRadius: 24)
                    .stroke(
                        arManager.hasDetectedBody ? Color.green : Color.yellow,
                        style: StrokeStyle(lineWidth: 3, dash: [8, 8])
                    )
                    .frame(width: 320, height: 560)
                    .overlay(
                        VStack {
                            Text(arManager.hasDetectedBody ? "✓ 被験者を認識中 (LiDAR稼働)" : "全身を枠内に収めてください")
                                .font(.caption)
                                .fontWeight(.bold)
                                .foregroundColor(arManager.hasDetectedBody ? .green : .yellow)
                                .padding(6)
                                .background(Color.black.opacity(0.6))
                                .cornerRadius(8)
                                .padding(.top, 12)
                            Spacer()
                            if arManager.hasDetectedBody {
                                Text(String(format: "被験者までの距離: %.2f m", arManager.currentDistanceMeters))
                                    .font(.caption2)
                                    .foregroundColor(.white)
                                    .padding(4)
                                    .background(Color.black.opacity(0.6))
                                    .cornerRadius(6)
                                    .padding(.bottom, 12)
                            }
                        }
                    )
                Spacer()
            }

            // 3. 上部コントロールバー（プロトコル選択 & ステータス）
            VStack {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("STS Biomechanical Analyzer")
                            .font(.headline)
                            .foregroundColor(.white)
                        Text("iPad Pro LiDAR ✕ 3D生体力学一括測定")
                            .font(.caption2)
                            .foregroundColor(.white.opacity(0.8))
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color.black.opacity(0.5))
                    .cornerRadius(12)

                    Spacer()

                    // プロトコル選択
                    Picker("測定モード", selection: $selectedMode) {
                        Text("単回起立").tag("SINGLE")
                        Text("5回立ち座り").tag("FIVE_TIMES")
                        Text("30秒起立").tag("THIRTY_SECONDS")
                    }
                    .pickerStyle(SegmentedPickerStyle())
                    .frame(width: 320)
                    .background(Color.white.opacity(0.9))
                    .cornerRadius(8)
                    .disabled(arManager.isRecording)
                }
                .padding(.horizontal, 24)
                .padding(.top, 16)

                Spacer()

                // 4. 下部コントロールバー（開始/停止ボタン & 録画ステータス）
                VStack(spacing: 16) {
                    if arManager.isRecording {
                        HStack(spacing: 12) {
                            Circle()
                                .fill(Color.red)
                                .frame(width: 12, height: 12)
                            Text(String(format: "測定中: %02d秒 (%d フレーム記録済)", timerSeconds, arManager.recordedFramesCount))
                                .font(.subheadline)
                                .fontWeight(.bold)
                                .foregroundColor(.white)
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(Color.red.opacity(0.8))
                        .cornerRadius(20)
                    }

                    HStack(spacing: 40) {
                        // 測定開始 / 停止ボタン
                        Button(action: {
                            if arManager.isRecording {
                                stopMeasurement()
                            } else {
                                startMeasurement()
                            }
                        }) {
                            HStack(spacing: 12) {
                                Image(systemName: arManager.isRecording ? "stop.fill" : "record.circle")
                                    .font(.title2)
                                Text(arManager.isRecording ? "測定停止して解析" : "測定開始 (LiDAR+骨格)")
                                    .font(.headline)
                                    .fontWeight(.bold)
                            }
                            .frame(width: 280, height: 60)
                            .foregroundColor(.white)
                            .background(arManager.isRecording ? Color.red : Color.blue)
                            .cornerRadius(30)
                            .shadow(radius: 8)
                        }
                    }
                }
                .padding(.bottom, 32)
            }
        }
        .onAppear {
            arManager.startSession()
        }
        .onDisappear {
            arManager.pauseSession()
        }
    }

    private func startMeasurement() {
        timerSeconds = 0
        arManager.startRecording()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            timerSeconds += 1
        }
    }

    private func stopMeasurement() {
        timer?.invalidate()
        timer = nil
        _ = arManager.stopRecording()

        // 記録された JSON データを取得し、即座に解析タブへ切り替え
        if let json = arManager.getRecordedDataAsJSON() {
            latestJsonData = json
            currentTab = 1 // 解析画面へ
        }
    }
}

// ARView を SwiftUI にブリッジする UIViewRepresentable
struct ARViewContainer: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let arView = ARSCNView(frame: .zero)
        arView.session = session
        arView.autoenablesDefaultLighting = true
        arView.showsStatistics = false
        return arView
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
