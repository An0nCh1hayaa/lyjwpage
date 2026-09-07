import SwiftUI

/**
 上报地址、密钥、模块开关。

 和 Mac 那个的设置窗口对应；模块开关按 `Modules.all` 现列，加模块不用改这里。
 */
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var endpoint = HubSettings.endpoint
    @State private var secret = HubSettings.secret
    @State private var enabled: [String: Bool] = Dictionary(
        uniqueKeysWithValues: Modules.all.map { ($0.id, HubSettings.isEnabled($0.id)) }
    )
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // 占位符不写成一个完整 URL —— 那看着就像已经填好了
                    TextField("上报地址", text: $endpoint)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("密钥", text: $secret)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("上报到哪儿")
                } footer: {
                    Text("地址形如 https://api.homepage.lyjw.llc/api/ingest/iphone，密钥就是站点的 TELEMETRY_INGEST_SECRET。密钥存在钥匙串里，数据只发往这一个地址。")
                }

                Section {
                    ForEach(Modules.all, id: \.id) { module in
                        Toggle(module.title, isOn: Binding(
                            get: { enabled[module.id] ?? true },
                            set: { enabled[module.id] = $0 }
                        ))
                    }
                } header: {
                    Text("模块")
                } footer: {
                    Text("关掉的模块不采集也不上报。站点那边的数据会停在最后一次上报上 —— 它不会因此变成「离线」，这条链路本来就没有存活判定。")
                }

                if !note.isEmpty {
                    Section {
                        Text(note).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
        }
    }

    private func save() {
        HubSettings.endpoint = endpoint
        HubSettings.secret = secret
        for (id, isOn) in enabled {
            HubSettings.setEnabled(isOn, for: id)
        }

        guard HubSettings.destination() != nil else {
            // 地址不成立就不关窗：关掉的话人以为存上了，实际每次上报都在跳过
            endpoint = HubSettings.endpoint
            note = "地址填得不完整，要带 https:// 和域名"
            return
        }
        dismiss()
    }
}
