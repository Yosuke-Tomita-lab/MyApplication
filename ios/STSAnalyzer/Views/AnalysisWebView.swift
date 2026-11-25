//
//  AnalysisWebView.swift
//  STSAnalyzer
//
//  Created for iPad Pro LiDAR Sit-to-Stand Biomechanical Analysis
//

import SwiftUI
import WebKit

struct AnalysisWebView: View {
    let jsonData: String?
    let mode: String
    @Binding var currentTab: Int

    @State private var webView = WKWebView()
    @State private var isLoaded = false

    var body: some View {
        VStack(spacing: 0) {
            // 上部ナビゲーションバー
            HStack {
                Button(action: {
                    currentTab = 0 // 撮影画面へ戻る
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.left")
                        Text("新しい測定を撮影する")
                    }
                    .font(.subheadline)
                    .fontWeight(.bold)
                    .foregroundColor(.blue)
                }

                Spacer()

                HStack(spacing: 8) {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 8, height: 8)
                    Text("iPad Pro LiDAR 実測データ解析中")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.secondary)
                }

                Spacer()

                // AirPrint 印刷ボタン
                Button(action: {
                    triggerPrint()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "printer")
                        Text("A4印刷 / PDF保存")
                    }
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .cornerRadius(8)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color(UIColor.systemBackground))
            .shadow(color: Color.black.opacity(0.05), radius: 2, y: 1)

            // Web 解析エンジン (WKWebView)
            LocalWebViewRepresentable(webView: $webView, isLoaded: $isLoaded, jsonData: jsonData, mode: mode)
                .edgesIgnoringSafeArea(.bottom)
        }
    }

    private func triggerPrint() {
        let printController = UIPrintInteractionController.shared
        let printInfo = UIPrintInfo(dictionary: nil)
        printInfo.outputType = .general
        printInfo.jobName = "STS_Analysis_Report"
        printController.printInfo = printInfo
        printController.printFormatter = webView.viewPrintFormatter()
        printController.present(animated: true, completionHandler: nil)
    }
}

struct LocalWebViewRepresentable: UIViewRepresentable {
    @Binding var webView: WKWebView
    @Binding var isLoaded: Bool
    let jsonData: String?
    let mode: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = context.coordinator

        // ローカル Web フォルダ内の index.html をロード
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web") {
            wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }

        DispatchQueue.main.async {
            self.webView = wv
        }
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        if isLoaded, let json = jsonData {
            context.coordinator.sendDataToWeb(uiView: uiView, json: json, mode: mode)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        var parent: LocalWebViewRepresentable
        private var hasInjected = false

        init(_ parent: LocalWebViewRepresentable) {
            self.parent = parent
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.isLoaded = true
            if let json = parent.jsonData, !hasInjected {
                sendDataToWeb(uiView: webView, json: json, mode: parent.mode)
            }
        }

        func sendDataToWeb(uiView: WKWebView, json: String, mode: String) {
            hasInjected = true
            // エスケープ処理して JavaScript 関数へ安全に受け渡し
            let escapedJson = json
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "")

            let script = """
            if (window.loadNativeARKitData) {
                window.loadNativeARKitData('\(escapedJson)', '\(mode)');
            } else {
                console.warn('loadNativeARKitData not ready yet');
            }
            """

            uiView.evaluateJavaScript(script) { result, error in
                if let error = error {
                    print("JavaScript injection error: \(error)")
                } else {
                    print("Native ARKit LiDAR data injected successfully")
                }
            }
        }
    }
}
