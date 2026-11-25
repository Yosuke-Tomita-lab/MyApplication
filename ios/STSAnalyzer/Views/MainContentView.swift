//
//  MainContentView.swift
//  STSAnalyzer
//
//  Created for iPad Pro LiDAR Sit-to-Stand Biomechanical Analysis
//

import SwiftUI

struct MainContentView: View {
    @StateObject private var arManager = ARKitManager()
    @State private var currentTab: Int = 0 // 0: 測定, 1: 解析結果
    @State private var selectedMode: String = "FIVE_TIMES"
    @State private var latestJsonData: String? = nil

    var body: some View {
        ZStack {
            if currentTab == 0 {
                ARCaptureView(
                    arManager: arManager,
                    selectedMode: $selectedMode,
                    currentTab: $currentTab,
                    latestJsonData: $latestJsonData
                )
                .transition(.asymmetric(insertion: .opacity, removal: .opacity))
            } else {
                AnalysisWebView(
                    jsonData: latestJsonData,
                    mode: selectedMode,
                    currentTab: $currentTab
                )
                .transition(.asymmetric(insertion: .opacity, removal: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: currentTab)
    }
}
