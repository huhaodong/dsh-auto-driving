window.__ModuleLoader__.load({
	id: "dsh-model-fallback",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		let react = require("react");

		//#region css
		const CSS = [
			`.dshmfb{display:flex;flex-direction:column;gap:14px;max-width:720px}`,
			`.dshmfb-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}`,
			`.dshmfb-desc{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}`,
			`.dshmfb-toggle{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none;width:fit-content}`,
			`.dshmfb-toggle input{cursor:pointer}`,
			`.dshmfb-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}`,
			`.dshmfb-row{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}`,
			`.dshmfb-rowSelected{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}`,
			`.dshmfb-rowHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}`,
			`.dshmfb-order{flex:none;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center}`,
			`.dshmfb-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
			`.dshmfb-id{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}`,
			`.dshmfb-badge{flex:none;font-size:11px;padding:1px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}`,
			`.dshmfb-badgeOk{color:#7ddb9c;border-color:rgba(125,219,156,.35)}`,
			`.dshmfb-badgeErr{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}`,
			`.dshmfb-models{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5;word-break:break-all}`,
			`.dshmfb-rowActions{display:flex;gap:6px}`,
			`.dshmfb-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 10px;cursor:pointer}`,
			`.dshmfb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
			`.dshmfb-btn:disabled{opacity:.45;cursor:default}`,
			`.dshmfb-primary{background:#4f7cff;border-color:#4f7cff;color:#fff}`,
			`.dshmfb-primary:hover:not(:disabled){background:#3f66d9}`,
			`.dshmfb-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}`,
			`.dshmfb-status{font-size:12px;color:var(--dsw-alias-label-tertiary)}`,
			`.dshmfb-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}`,
			`.dshmfb-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;margin:0}`,
			`.dshmfb-hint{margin:0;font-size:12px;color:#e0a24c}`,
			`.dshmfb-retry{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-3)}`,
			`.dshmfb-retryTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}`,
			`.dshmfb-retryDesc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}`,
			`.dshmfb-retryRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}`,
			`.dshmfb-retryLabel{font-size:12px;color:var(--dsw-alias-label-primary);min-width:80px}`,
			`.dshmfb-retryInput{width:72px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font:inherit}`,
			`.dshmfb-retryInput:disabled{opacity:.5}`,
			`.dshmfb-retryCodes{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;line-height:1.5}`,
			`.dshmfb-retryInputWide{flex:1;min-width:240px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}`,
			`.dshmfb-retryInputWide:disabled{opacity:.5}`,
			`.dshmfb-retryInputWide::placeholder{color:var(--dsw-alias-label-dimmed)}`,
			`.dshmfb-retryField{display:flex;flex-direction:column;gap:3px;min-width:0}`,
			`.dshmfb-retryFieldHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}`,
			`.dshmfb-retryHint{font-size:11px;color:var(--dsw-alias-label-dimmed);margin:0;line-height:1.5}`,
			`.dshmfb-retryPreview{font-size:11px;color:#7ddb9c;margin:0}`,
			`.dshmfb-autoPill{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:12px;font:inherit;cursor:pointer;flex:none;white-space:nowrap}`,
			`.dshmfb-autoPill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
			`.dshmfb-autoPill:disabled{opacity:.45;cursor:default}`,
			`.dshmfb-autoOn{border-color:rgba(125,219,156,.55);color:#7ddb9c;background:rgba(125,219,156,.12)}`,
			`.dshmfb-autoDot{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-label-dimmed);flex:none}`,
			`.dshmfb-autoOn .dshmfb-autoDot{background:#7ddb9c;box-shadow:0 0 6px rgba(125,219,156,.8)}`,
			`.dshmfb-comboPill{display:inline-flex;align-items:center;height:26px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);overflow:hidden;flex:none}`,
			`.dshmfb-comboPill:focus-within{border-color:rgba(125,219,156,.55)}`,
			`.dshmfb-halfPill{flex:1;display:flex;align-items:center;justify-content:center;width:30px;height:100%;padding:0;background:transparent;border:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}`,
			`.dshmfb-halfPill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
			`.dshmfb-halfPill:disabled{opacity:.45;cursor:default}`,
			`.dshmfb-halfPill svg{width:14px;height:14px;pointer-events:none}`,
			`.dshmfb-halfPill.on{color:#7ddb9c;background:rgba(125,219,156,.12)}`,
			`.dshmfb-halfPill.on:hover:not(:disabled){background:rgba(125,219,156,.18)}`,
			`.dshmfb-log{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-3)}`,
			`.dshmfb-logList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;max-height:260px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}`,
			`.dshmfb-logRow{display:flex;gap:8px;font-size:11px;line-height:1.5;align-items:baseline;min-width:0}`,
			`.dshmfb-logTime{flex:none;color:var(--dsw-alias-label-dimmed);white-space:nowrap}`,
			`.dshmfb-logLevel{flex:none;font-weight:600;width:38px}`,
			`.dshmfb-logWarn .dshmfb-logLevel{color:#e0a24c}`,
			`.dshmfb-logInfo .dshmfb-logLevel{color:#7ddb9c}`,
			`.dshmfb-logMsg{color:var(--dsw-alias-label-tertiary);word-break:break-all;min-width:0}`,
			`.dshmfb-logWarn .dshmfb-logMsg{color:var(--dsw-alias-label-primary)}`,
			`.dshmfb-logEmpty{font-size:12px;color:var(--dsw-alias-label-dimmed);padding:10px;text-align:center}`,
			`.dshmfb-logAuto{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer;user-select:none;width:fit-content}`,
			`.dshmfb-logAuto input{cursor:pointer}`,
			`.dshmfb-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-3)}`,
			`.dshmfb-cardTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px;flex-wrap:wrap}`,
			`.dshmfb-cardDesc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}`,
			`.dshmfb-sectionLabel{margin:24px 0 0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-dimmed)}`,
			`.dshmfb-sectionLabel:first-of-type{margin-top:0}`,
			`.dshmfb-arrearsClose{margin-left:2px;border:none;background:transparent;color:var(--dsw-alias-state-error-primary);cursor:pointer;font-size:14px;line-height:1;padding:0 2px}`,
			`.dshmfb-arrearsClose:hover:not(:disabled){color:#ff6b6b}`,
			`.dshmfb-arrearsClose:disabled{opacity:.45;cursor:default}`,
			`.dshmfb-modelPool{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2)}`,
			`.dshmfb-modelPoolLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}`,
			`.dshmfb-modelChip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}`,
			`.dshmfb-modelChip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
			`.dshmfb-modelChip:disabled{opacity:.45;cursor:default}`,
			`.dshmfb-modelChip input{margin:0;cursor:pointer}`,
		].join("");
		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-dsh-plugin="dsh-model-fallback"]')) return;
			const tag = document.createElement("style");
			tag.dataset.dshPlugin = "dsh-model-fallback";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region lib/types/client/locales.js
		const NS = "model-fallback";
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			nav: "模型回退",
			title: "模型供应商分组自动回退",
			desc: "勾选参与循环的供应商（可排序）。当某次模型请求在产出任何内容之前失败（模型不存在、无可用凭据、额度耗尽、限流、上下文超限、服务端错误等），会自动切换到分组中的下一个模型继续同一个请求，直到找到可用模型，正在进行的任务无感继续。所有候选都失败时按原样返回错误；用户主动中断不会触发切换。",
			enabled: "启用自动回退",
			notWritable: "当前连接不支持写入设置（仅本机回环连接可修改）。",
			active: "已启用",
			inactive: "未启用",
			catalogFailure: "目录失败",
			noModels: "该供应商暂无模型目录（请在「模型」设置页配置模型）",
			models: "模型",
			arrears: "欠费",
			arrearsHint: "该账户/API key 近期触发欠费或鉴权失败，已自动移出回退池；点击 × 恢复",
			arrearsClose: "清除欠费标记",
			modelPool: "模型池",
			modelPoolHint: "未勾选的模型不会作为该分组的回退候选；不配置时默认全部启用",
			moveUp: "上移",
			moveDown: "下移",
			hintOrder: "循环优先级：数字越小越先尝试",
			refresh: "刷新",
			refreshing: "刷新中…",
			retry: "重试",
			discard: "放弃修改",
			save: "保存",
			saving: "保存中…",
			unsaved: "有未保存的修改",
			loadError: "供应商目录加载失败",
			noProviders: "尚未发现任何已配置的模型供应商。请先在「模型」设置页添加并启用供应商。",
			statusTitle: "运行状态",
			statusProtect: "未选定分组也纳入保护",
			statusProtectHint: "请求使用未勾选分组的模型时也进行包装：请求模型打头，选定分组作为候选池，任何请求都有恢复网（含 403/500 自动切换）",
			statusChain: "链预览",
			statusModels: "个模型",
			statusEmptyGroup: "该分组目录为 0 个模型，不贡献回退候选——请在「模型」页确认，或改选对应的原生分组",
			statusRequested: "请求分组",
			statusAllProviders: "全部供应商兜底",
			statusAllProvidersHint: "选定分组全部失败后，把其余已配置供应商的模型追加为最后候选（可能消耗未勾选供应商的额度）",
			retrySection: "任务重试",
			retryEnabled: "启用任务重试",
			retryDesc: "当所有候选模型都失败且错误属于非模型异常（网络超时、连接断开、服务端错误等）时，用同一模型自动重试，直到成功或达到最大重试次数。用户主动中断不会触发重试。",
			maxRetries: "最大重试次数",
			baseDelay: "基础延迟(ms)",
			retryableCodes: "可重试错误码",
			maxRetriesHint: "候选链全部失败后，用原始模型重试的最大次数（0 表示不重试）",
			loopRetry: "循环级重试",
			watchdog: "活性看门狗",
			watchdogHint: "请求超过 2 分钟无任何输出（含心跳）即判定卡住：强制终止并按链切换/重试，让卡住的任务重新激活",
			watchdogIdle: "看门狗空闲阈值(ms)",
			watchdogIdleHint: "静默多久判定为卡住；最低 250ms，默认 300000（5 分钟）。静默=已连接且未欠费（402/403 会立即报错，不会静默）",
			watchdogResends: "静默重发次数",
			watchdogResendsHint: "判定卡住后用同一模型原样重发的次数；重发用尽才切换候选模型",
			loopRetryHint: "流中途失败时，由 agent 循环丢弃半截消息并在同一模型上整轮重发（共用上面的次数与延迟）",
			baseDelayHint: "首次重试前的等待时间；后续每次翻倍，单次上限 10 秒",
			retryCodesPlaceholder: "NETWORK_ERROR, TIMEOUT, …（留空 = 除已知模型错误外全部重试）",
			retryCodesHint: "逗号或空格分隔。留空时：UNKNOWN_MODEL、QUOTA、CONTEXT_OVERFLOW、MODEL_UNAVAILABLE、AUTH_FAILED、RATE_LIMITED 之外的所有错误码都会重试。TRANSPORT、NETWORK_ERROR、TIMEOUT、CONNECTION_CLOSED 四类传输层瞬态错误始终可重试（不受列表限制）。",
			backoffPreview: "重试间隔",
			restoreDefaults: "恢复默认",
			autoNav: "全自动模式",
			autoTitle: "全自动模式（默认允许）",
			autoDesc: "开启后，任务运行中的权限索取、确认提问、方案评审都会按默认允许自动应答，任务不再等待人工验证。每次自动允许的操作会写入会话工作区的 AUTO-MODE.md 审计文件，随时可查插件允许了什么。默认关闭。",
			autoEnabled: "启用全自动模式",
			autoPermissions: "自动允许权限审批",
			autoPermissionsHint: "工具执行所需的权限审批（如命令沙箱提权、文件写入确认）一律按允许处理",
			autoQuestions: "自动应答确认提问",
			autoQuestionsHint: "ask_user_question 等人工选择按推荐项（第一个选项）自动应答",
			autoPlans: "自动批准方案评审",
			autoPlansHint: "exit_plan_mode 提交的实施方案按「批准」自动通过，评审不再等待人工",
			workspaceLog: "工作区审计日志",
			workspaceLogHint: "把每一次自动允许/自动应答追加到会话工作区根目录的 AUTO-MODE.md",
			autoAuditFile: "审计文件",
			sectionFallback: "回退分组",
			sectionRetry: "任务重试",
			sectionStatus: "运行状态",
			autoPill: "自动驾驶",
			fallbackPill: "模型回退",
			fallbackPillOn: "模型自动回退已开启：当前模型失败时自动切换到候选模型（点击关闭）",
			fallbackPillOff: "模型自动回退已关闭（点击开启）",
			fallbackPillBusy: "切换中…",
			switchNotify: "模型已切换: {from} → {to}",
			switchRecovered: "已在 {model} 恢复执行",
			switchSyncFail: "模型选择同步失败（会话可能不支持）",
			autoPillOn: "自动驾驶已开启：权限审批、确认提问、方案评审全部自动允许（点击关闭）",
			autoPillOff: "自动驾驶已关闭：人工确认保持默认（点击开启）",
			autoPillBusy: "切换中…",
			autoAnsweredNotice: "已自动应答确认提问",
			autoAllowedNotice: "已自动允许权限",
			stateOn: "开",
			stateOff: "关",
			logTitle: "工作日志",
			logDesc: "插件最近的介入记录（切换/恢复/重试/耗尽/决策/自动允许），最新在前。与宿主日志同源。",
			logRefresh: "刷新",
			logAuto: "自动刷新(5s)",
			logEmpty: "暂无日志——插件尚未介入任何请求。发起一次对话后，这里会显示 engaged 决策行。",
			logError: "日志加载失败",
			autoAuditHint: "会话工作区根目录下的 AUTO-MODE.md（开启审计后自动创建）",
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			nav: "Model Fallback",
			title: "Provider-group model fallback",
			desc: "Tick the providers that join the loop (order adjustable). When a model request fails before producing any content (unknown model, missing credential, exhausted quota, rate limit, context overflow, server error, …), the request automatically continues on the next model in the group until one works, so the running task keeps going without interruption. The original error is surfaced once every candidate failed; user-initiated aborts never trigger a switch.",
			enabled: "Enable automatic fallback",
			notWritable: "This connection cannot write settings (loopback connections only).",
			active: "active",
			inactive: "inactive",
			catalogFailure: "catalog failed",
			noModels: "No model catalog for this provider (configure models on the Models page)",
			models: "Models",
			arrears: "arrears",
			arrearsHint: "This account/API key recently hit a wallet-level failure (402/quota) and was pulled from the fallback pool; click × to restore",
			arrearsClose: "Clear arrears marker",
			modelPool: "Model pool",
			modelPoolHint: "Unchecked models are not used as fallback candidates for this group; leaving it unset means all models are allowed",
			moveUp: "Up",
			moveDown: "Down",
			hintOrder: "Loop priority: lower numbers are tried first",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			retry: "Retry",
			discard: "Discard",
			save: "Save",
			saving: "Saving…",
			unsaved: "Unsaved changes",
			loadError: "Failed to load the provider directory",
			noProviders: "No configured model providers found. Add and enable providers on the Models page first.",
			statusTitle: "Runtime status",
			statusProtect: "Protect unselected groups too",
			statusProtectHint: "Requests on unselected providers are wrapped as well: the requested model leads and the selected groups serve as the candidate pool, so every request carries a recovery net (403/500 auto-switch included)",
			statusChain: "Chain preview",
			statusModels: "models",
			statusEmptyGroup: "This group lists 0 models and contributes no fallback candidates — check the Models page or select the raw provider group instead",
			statusRequested: "requested group",
			statusAllProviders: "All-providers fallback",
			statusAllProvidersHint: "After the selected groups fail, every other configured provider's models join as last-resort candidates (may spend quota outside the selection)",
			retrySection: "Task Retry",
			retryEnabled: "Enable task retry",
			retryDesc: "When all candidate models fail and the error is a non-model exception (network timeout, connection closed, server error, …), automatically retry with the same model until success or the max retry count is reached. User-initiated aborts never trigger a retry.",
			maxRetries: "Max retries",
			baseDelay: "Base delay (ms)",
			retryableCodes: "Retryable codes",
			maxRetriesHint: "Max attempts on the original model after every candidate failed (0 disables retry)",
			loopRetry: "Loop-level retry",
			watchdog: "Liveness watchdog",
			watchdogHint: "A request with NO output (not even keep-alives) for over 2 minutes is presumed hung: terminated and re-activated through the normal switch/retry machinery",
			watchdogIdle: "Watchdog idle threshold (ms)",
			watchdogIdleHint: "Silent gap before a request is presumed hung; minimum 250 ms, default 300000 (5 min). Silence means connected and not rejected — 402/403 arrive instantly as errors",
			watchdogResends: "Silent resends",
			watchdogResendsHint: "How many times the same model is re-sent after a silence verdict; the chain switches only after the budget is spent",
			loopRetryHint: "On mid-stream failures the agent loop discards the partial message and re-issues the whole request on the same model (shares the attempt count and delays above)",
			baseDelayHint: "Wait before the first retry; each following retry doubles, capped at 10 s",
			retryCodesPlaceholder: "NETWORK_ERROR, TIMEOUT, … (empty = retry every non-model error)",
			retryCodesHint: "Comma- or space-separated. When empty: every code except known model errors (UNKNOWN_MODEL, QUOTA, CONTEXT_OVERFLOW, MODEL_UNAVAILABLE, AUTH_FAILED, RATE_LIMITED) is retried. The transport-level transient codes TRANSPORT, NETWORK_ERROR, TIMEOUT and CONNECTION_CLOSED are always retried regardless of the list.",
			backoffPreview: "Retry intervals",
			restoreDefaults: "Restore defaults",
			autoNav: "Full Auto",
			autoTitle: "Full-auto mode (default-allow)",
			autoDesc: "When enabled, permission requests, confirmation questions, and plan reviews are answered automatically with the default-allow choice, so tasks never stall on human verification. Every automatic decision is appended to AUTO-MODE.md in the session workspace so you can always see what the plugin allowed. Off by default.",
			autoEnabled: "Enable full-auto mode",
			autoPermissions: "Auto-allow permission requests",
			autoPermissionsHint: "Tool-execution approvals (command sandbox escalation, file-write confirmations, …) are allowed automatically",
			autoQuestions: "Auto-answer confirmation questions",
			autoQuestionsHint: "ask_user_question and similar prompts are answered with the recommended (first) option",
			autoPlans: "Auto-approve plan reviews",
			autoPlansHint: "Plans submitted through exit_plan_mode are approved automatically; review no longer waits for a human",
			workspaceLog: "Workspace audit log",
			workspaceLogHint: "Append every automatic allow/answer to AUTO-MODE.md in the session workspace root",
			autoAuditFile: "Audit file",
			sectionFallback: "Fallback groups",
			sectionRetry: "Task retry",
			sectionStatus: "Runtime status",
			autoPill: "Auto-drive",
			fallbackPill: "Fallback",
			fallbackPillOn: "Model fallback ON: automatically switches to the next candidate when the current model fails (click to turn off)",
			fallbackPillOff: "Model fallback OFF (click to turn on)",
			fallbackPillBusy: "switching…",
			switchNotify: "Model switched: {from} → {to}",
			switchRecovered: "Execution recovered on {model}",
			switchSyncFail: "Model-selector sync failed (session may not support it)",
			autoPillOn: "Auto-drive ON: permission approvals, confirmations, and plan reviews are auto-allowed (click to turn off)",
			autoPillOff: "Auto-drive OFF: confirmations stay manual (click to turn on)",
			autoPillBusy: "switching…",
			autoAnsweredNotice: "Auto-answered confirmation",
			autoAllowedNotice: "Auto-allowed permission",
			stateOn: "ON",
			stateOff: "OFF",
			logTitle: "Activity log",
			logDesc: "The plugin's recent interventions (switches/recoveries/retries/exhaustions/decisions/auto-allows), newest first. Same source as the host log.",
			logRefresh: "Refresh",
			logAuto: "Auto refresh (5s)",
			logEmpty: "No entries yet — the plugin has not engaged any request. Start a conversation and the engaged decision lines appear here.",
			logError: "Failed to load the log",
			autoAuditHint: "AUTO-MODE.md in the session workspace root (created automatically once the audit is on)",
		};
		//#endregion

		/** Account key for one provider route (mirrors the host). */
		function accountKeyOf(route) {
			return typeof route === "string" && route.startsWith("modlens-") ? route.slice("modlens-".length) : route;
		}

		//#region lib/types/client/catalog.js
		/**
		 * Join the configurable-provider directory with the model catalog.
		 * @param api - the client wire face (`llm` domain).
		 * @returns provider rows: identity, active flag, and its model list.
		 */
		async function loadCatalog(api) {
			const [providersResponse, modelsResponse] = await Promise.all([
				api.llm.providers({}),
				api.llm.models({}).catch(() => null),
			]);
			if (!providersResponse?.result?.ok) {
				throw new Error(providersResponse?.result?.error?.message ?? "llm.providers failed");
			}
			const providers = providersResponse.result.value?.providers ?? [];
			const groups = modelsResponse?.result?.ok ? modelsResponse.result.value?.groups ?? [] : [];
			const failures = modelsResponse?.result?.ok ? modelsResponse.result.value?.failures ?? [] : [];
			const modelsById = new Map(groups.map((group) => [group.id, Array.isArray(group.models) ? group.models : []]));
			const failureById = new Map(failures.map((failure) => [failure.id, failure.message ?? ""]));
			return providers.map((provider) => ({
				id: provider.provider,
				name: provider.displayName,
				active: provider.active === true,
				models: modelsById.get(provider.provider) ?? [],
				failure: failureById.get(provider.provider) || null,
			}));
		}
		//#endregion

		//#region lib/types/client/FallbackSection.js
		const h = react.createElement;
		/** One provider row inside the loop list. */
		function ProviderRow({ row, t, selected, order, editable, onToggle, onMove, arrears, providerModels, onClearArrears, onToggleModel }) {
			const ids = row.models
				.map((model) => (model && typeof model === "object" ? model.id : model))
				.filter((id) => typeof id === "string" && id.length > 0);
			const preview = ids.slice(0, 5).join(", ");
			const extra = ids.length - 5;
			const accountKey = accountKeyOf(row.id);
			const isArrears = arrears?.[accountKey] === true;
			const selectedModels = providerModels?.[row.id];
			const allSelected = !Array.isArray(selectedModels);
			const allowedSet = new Set(allSelected ? ids : selectedModels.filter((id) => ids.includes(id)));
			return h(
				"li",
				{ className: selected ? "dshmfb-row dshmfb-rowSelected" : "dshmfb-row" },
				h(
					"div",
					{ className: "dshmfb-rowHead" },
					h("input", {
						type: "checkbox",
						checked: selected,
						disabled: !editable,
						onChange: () => onToggle(row.id),
						"aria-label": row.name,
					}),
					selected ? h("span", { className: "dshmfb-order", title: t("hintOrder") }, String(order + 1)) : null,
					h("span", { className: "dshmfb-name" }, row.name),
					h("span", { className: "dshmfb-id" }, row.id),
					row.active ? h("span", { className: "dshmfb-badge dshmfb-badgeOk" }, t("active")) : h("span", { className: "dshmfb-badge" }, t("inactive")),
					row.failure ? h("span", { className: "dshmfb-badge dshmfb-badgeErr", title: row.failure }, t("catalogFailure")) : null,
					isArrears
						? h("span", { className: "dshmfb-badge dshmfb-badgeErr", title: t("arrearsHint") }, t("arrears"))
						: null,
					isArrears && editable
						? h("button", { className: "dshmfb-arrearsClose", type: "button", title: t("arrearsClose"), disabled: !editable, onClick: () => onClearArrears(accountKey) }, "×")
						: null,
				),
				h("div", { className: "dshmfb-models" }, ids.length === 0 ? t("noModels") : `${t("models")}: ${preview}${extra > 0 ? ` +${extra}` : ""}`),
				selected && ids.length > 0
					? h(
							"div",
							{ className: "dshmfb-modelPool" },
							h("span", { className: "dshmfb-modelPoolLabel" }, `${t("modelPool")}:`),
							ids.map((id) =>
								h(
									"label",
									{ key: id, className: "dshmfb-modelChip", title: t("modelPoolHint") },
									h("input", {
										type: "checkbox",
										checked: allowedSet.has(id),
										disabled: !editable,
										onChange: () => onToggleModel(row.id, id),
									}),
									id,
								),
							),
					  )
					: null,
				selected && editable
					? h(
							"div",
							{ className: "dshmfb-rowActions" },
							h("button", { className: "dshmfb-btn", type: "button", onClick: () => onMove(row.id, -1) }, t("moveUp")),
							h("button", { className: "dshmfb-btn", type: "button", onClick: () => onMove(row.id, 1) }, t("moveDown")),
						)
					: null,
			);
		}

		/** Default retryable codes — mirrors the host-side DEFAULT_RETRYABLE_CODES. */
		const DEFAULT_RETRYABLE_CODES = [
			"NETWORK_ERROR",
			"TIMEOUT",
			"CONNECTION_CLOSED",
			"RATE_LIMITED",
			"SERVER_ERROR",
			"500",
			"502",
			"503",
			"504",
		];
		/** Known model-error classes shown in the codes hint. */
		const MODEL_ERROR_CODES = ["UNKNOWN_MODEL", "QUOTA", "CONTEXT_OVERFLOW", "MODEL_UNAVAILABLE", "AUTH_FAILED", "RATE_LIMITED"];

		/** Format one backoff delay for the preview line. */
		function formatDelay(ms) {
			if (ms >= 1000) {
				const seconds = ms / 1000;
				return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
			}
			return `${ms}ms`;
		}

		/** Build the "500ms → 1s → 2s" preview for the current settings. */
		function backoffPreview(baseDelayMs, maxRetries) {
			if (!(baseDelayMs >= 0) || !(maxRetries > 0)) return "—";
			const parts = [];
			for (let attempt = 1; attempt <= Math.min(maxRetries, 6); attempt += 1) {
				parts.push(formatDelay(Math.min(baseDelayMs * Math.pow(2, attempt - 1), 10000)));
			}
			if (maxRetries > 6) parts.push("…");
			return parts.join(" → ");
		}

		/** Parse the free-form codes text into a clean array. */
		function parseCodesText(text) {
			return String(text ?? "")
				.split(/[\s,，、]+/)
				.map((code) => code.trim())
				.filter((code) => code.length > 0);
		}

		/**
		 * Task-retry settings card: master switch, max retries, base delay, and the
		 * editable retryable-code list, plus a live backoff preview. Reads the bound
		 * settings scope; writes go through controller.set("retry", …) so the host
		 * picks the new policy up on the very next request.
		 */
		function RetrySection({ controller, t, writable }) {
			const [snap, setSnap] = react.useState(controller.getSnapshot());
			react.useEffect(() => controller.subscribe(() => setSnap(controller.getSnapshot())), [controller]);

			const ready = snap.status === "ready";
			const stored = ready && snap.value && typeof snap.value.retry === "object" && snap.value.retry !== null ? snap.value.retry : {};
			const baseEnabled = stored.enabled === true;
			const baseMax = typeof stored.maxRetries === "number" ? stored.maxRetries : 3;
			const baseDelay = typeof stored.baseDelayMs === "number" ? stored.baseDelayMs : 500;
			const baseCodes = Array.isArray(stored.retryableCodes) ? stored.retryableCodes : [];
			const baseLoopRetry = stored.loopRetry !== false;
			const baseWatchdog = stored.watchdog && typeof stored.watchdog === "object" ? stored.watchdog.enabled !== false : true;
			const baseWatchdogIdle = stored.watchdog && typeof stored.watchdog === "object" && typeof stored.watchdog.idleTimeoutMs === "number" ? stored.watchdog.idleTimeoutMs : 300000;
			const baseWatchdogResends = stored.watchdog && typeof stored.watchdog === "object" && typeof stored.watchdog.resends === "number" ? stored.watchdog.resends : 2;

			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [error, setError] = react.useState(null);

			/** Draft shape: { enabled, maxRetries, baseDelayMs, loopRetry, watchdog, watchdogIdleMs, codesText }. */
			const eff = draft ?? { enabled: baseEnabled, maxRetries: baseMax, baseDelayMs: baseDelay, loopRetry: baseLoopRetry, watchdog: baseWatchdog, watchdogIdleMs: baseWatchdogIdle, watchdogResends: baseWatchdogResends, codesText: baseCodes.join(", ") };
			eff.codesText = eff.codesText ?? "";

			const dirty =
				draft !== null &&
				ready &&
				(draft.enabled !== baseEnabled ||
					draft.maxRetries !== baseMax ||
					draft.baseDelayMs !== baseDelay ||
					draft.loopRetry !== baseLoopRetry ||
					draft.watchdog !== baseWatchdog ||
					draft.watchdogIdleMs !== baseWatchdogIdle ||
					draft.watchdogResends !== baseWatchdogResends ||
					JSON.stringify(parseCodesText(draft.codesText)) !== JSON.stringify(baseCodes));

			const setField = (field, value) => setDraft({ ...eff, [field]: value });

			const save = async () => {
				if (!draft || saving) return;
				setSaving(true);
				setError(null);
				try {
					await controller.set("retry", {
						enabled: draft.enabled === true,
						maxRetries: Math.max(0, Math.floor(draft.maxRetries) || 0),
						baseDelayMs: Math.max(0, Math.floor(draft.baseDelayMs) || 0),
						loopRetry: draft.loopRetry !== false,
						retryableCodes: parseCodesText(draft.codesText),
					});
					await controller.set("watchdog", {
						enabled: draft.watchdog !== false,
						idleTimeoutMs: Math.max(250, Math.floor(draft.watchdogIdleMs) || 300000),
						resends: Math.max(0, Math.floor(draft.watchdogResends) || 0),
					});
					setDraft(null);
				} catch (cause) {
					setError(String((cause && cause.message) || cause));
				} finally {
					setSaving(false);
				}
			};

			const restoreDefaults = () => {
				setDraft({ enabled: true, maxRetries: 3, baseDelayMs: 500, loopRetry: true, watchdog: true, watchdogIdleMs: 300000, watchdogResends: 2, codesText: DEFAULT_RETRYABLE_CODES.join(", ") });
			};

			const preview = backoffPreview(eff.baseDelayMs, eff.maxRetries);
			const codesPlaceholder = baseCodes.length > 0 ? baseCodes.join(", ") : t("retryCodesPlaceholder");

			return h(
				"div",
				{ className: "dshmfb-retry" },
				h(
					"div",
					{ className: "dshmfb-retryTitle" },
					t("retrySection"),
					eff.enabled === true
						? h("span", { className: "dshmfb-badge dshmfb-badgeOk" }, t("active"))
						: h("span", { className: "dshmfb-badge" }, t("inactive")),
				),
				h("p", { className: "dshmfb-retryDesc" }, t("retryDesc")),
				h(
					"label",
					{ className: "dshmfb-toggle" },
					h("input", {
						type: "checkbox",
						checked: eff.enabled === true,
						disabled: !writable,
						onChange: (event) => setField("enabled", event.target.checked),
					}),
					t("retryEnabled"),
				),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"div",
						{ className: "dshmfb-retryFieldHead" },
						h("span", { className: "dshmfb-retryLabel" }, t("maxRetries")),
						h("input", {
							className: "dshmfb-retryInput",
							type: "number",
							min: "0",
							max: "50",
							value: eff.maxRetries,
							disabled: !writable,
							onChange: (event) => setField("maxRetries", Math.max(0, parseInt(event.target.value, 10) || 0)),
						}),
					),
					h("p", { className: "dshmfb-retryHint" }, t("maxRetriesHint")),
				),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"div",
						{ className: "dshmfb-retryFieldHead" },
						h("span", { className: "dshmfb-retryLabel" }, t("baseDelay")),
						h("input", {
							className: "dshmfb-retryInput",
							type: "number",
							min: "0",
							step: "100",
							value: eff.baseDelayMs,
							disabled: !writable,
							onChange: (event) => setField("baseDelayMs", Math.max(0, parseInt(event.target.value, 10) || 0)),
						}),
					),
					h("p", { className: "dshmfb-retryHint" }, t("baseDelayHint")),
				),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"label",
						{ className: "dshmfb-toggle" },
						h("input", {
							type: "checkbox",
							checked: eff.loopRetry !== false,
							disabled: !writable,
							onChange: (event) => setField("loopRetry", event.target.checked),
						}),
						t("loopRetry"),
					),
					h("p", { className: "dshmfb-retryHint" }, t("loopRetryHint")),
				),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"label",
						{ className: "dshmfb-toggle" },
						h("input", {
							type: "checkbox",
							checked: eff.watchdog !== false,
							disabled: !writable,
							onChange: (event) => setField("watchdog", event.target.checked),
						}),
						t("watchdog"),
					),
					h("p", { className: "dshmfb-retryHint" }, t("watchdogHint")),
				),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"div",
						{ className: "dshmfb-retryFieldHead" },
						h("span", { className: "dshmfb-retryLabel" }, t("watchdogIdle")),
						h("input", {
							className: "dshmfb-retryInput",
							type: "number",
							min: "250",
							step: "1000",
							value: eff.watchdogIdleMs,
							disabled: !writable,
							onChange: (event) => setField("watchdogIdleMs", Math.max(250, parseInt(event.target.value, 10) || 250)),
						}),
					),
					h("p", { className: "dshmfb-retryHint" }, t("watchdogIdleHint")),
				),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"div",
						{ className: "dshmfb-retryFieldHead" },
						h("span", { className: "dshmfb-retryLabel" }, t("watchdogResends")),
						h("input", {
							className: "dshmfb-retryInput",
							type: "number",
							min: "0",
							max: "10",
							value: eff.watchdogResends,
							disabled: !writable,
							onChange: (event) => setField("watchdogResends", Math.max(0, parseInt(event.target.value, 10) || 0)),
						}),
					),
					h("p", { className: "dshmfb-retryHint" }, t("watchdogResendsHint")),
				),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"div",
						{ className: "dshmfb-retryFieldHead" },
						h("span", { className: "dshmfb-retryLabel" }, t("retryableCodes")),
						h("input", {
							className: "dshmfb-retryInputWide",
							type: "text",
							value: eff.codesText,
							placeholder: codesPlaceholder,
							spellCheck: false,
							disabled: !writable,
							onChange: (event) => setField("codesText", event.target.value),
						}),
					),
					h("p", { className: "dshmfb-retryHint" }, t("retryCodesHint")),
				),
				eff.enabled === true && eff.maxRetries > 0
					? h("p", { className: "dshmfb-retryPreview" }, `${t("backoffPreview")}: ${preview}`)
					: null,
				h(
					"div",
					{ className: "dshmfb-footer" },
					h("button", { className: "dshmfb-btn", type: "button", onClick: restoreDefaults, disabled: !writable || saving }, t("restoreDefaults")),
					h("button", { className: "dshmfb-btn", type: "button", onClick: () => setDraft(null), disabled: !dirty || saving }, t("discard")),
					h("button", { className: "dshmfb-btn dshmfb-primary", type: "button", onClick: save, disabled: !dirty || saving || !writable }, saving ? t("saving") : t("save")),
					dirty && ready && !saving ? h("span", { className: "dshmfb-status" }, t("unsaved")) : null,
				),
				error ? h("p", { className: "dshmfb-error" }, error) : null,
			);
		}

		/** One labeled toggle row (checkbox + label + hint) inside the auto card. */
		function AutoToggleRow({ t, labelKey, hintKey, checked, disabled, onChange }) {
			return h(
				"div",
				{ className: "dshmfb-retryField" },
				h(
					"label",
					{ className: "dshmfb-toggle" },
					h("input", {
						type: "checkbox",
						checked: checked === true,
						disabled,
						onChange: (event) => onChange(event.target.checked),
					}),
					t(labelKey),
				),
				h("p", { className: "dshmfb-retryHint" }, t(hintKey)),
			);
		}

		/**
		 * The "全自动模式" settings tab: master switch plus the per-channel
		 * auto-allow toggles and the workspace audit-log switch. Lives in its own
		 * settings namespace ("model-fallback-auto") so the tab stores and saves
		 * independently from the fallback tab.
		 */
		function AutoModeSection({ controller, t }) {
			const [snap, setSnap] = react.useState(controller.getSnapshot());
			react.useEffect(() => controller.subscribe(() => setSnap(controller.getSnapshot())), [controller]);
			// Belt-and-suspenders: the composer pill can toggle this namespace from
			// another surface; a light poll guarantees the tab never shows stale state.
			react.useEffect(() => {
				const timer = setInterval(() => setSnap(controller.getSnapshot()), 5000);
				return () => clearInterval(timer);
			}, [controller]);

			const ready = snap.status === "ready";
			// Top-level sections derive writability from their own scope snapshot —
			// the settings page injects only { controller, api, t }.
			const writable = snap.writable === true && snap.mode === "host";
			const stored = ready && snap.value && typeof snap.value === "object" ? snap.value : {};
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [error, setError] = react.useState(null);

			const keys = ["enabled", "autoAllowPermissions", "autoAnswerQuestions", "autoApprovePlans", "workspaceLog"];
			const base = {};
			for (const key of keys) base[key] = stored[key] === true;
			const eff = draft ?? base;
			const dirty = draft !== null && ready && keys.some((key) => draft[key] !== base[key]);

			const setField = (key, value) => setDraft({ ...eff, [key]: value });

			const save = async () => {
				if (!draft || saving) return;
				setSaving(true);
				setError(null);
				try {
					for (const key of keys) await controller.set(key, draft[key] === true);
					setDraft(null);
				} catch (cause) {
					setError(String((cause && cause.message) || cause));
				} finally {
					setSaving(false);
				}
			};

			return h(
				"div",
				{ className: "dshmfb" },
				h(
					"div",
					{ className: "dshmfb-cardTitle" },
					t("autoTitle"),
					eff.enabled === true
						? h("span", { className: "dshmfb-badge dshmfb-badgeOk" }, t("active"))
						: h("span", { className: "dshmfb-badge" }, t("inactive")),
				),
				h("p", { className: "dshmfb-desc" }, t("autoDesc")),
				h("div", { className: "dshmfb-card" },
					h(
						"label",
						{ className: "dshmfb-toggle" },
						h("input", {
							type: "checkbox",
							checked: eff.enabled === true,
							disabled: !writable,
							onChange: (event) => setField("enabled", event.target.checked),
						}),
						t("autoEnabled"),
					),
					h(AutoToggleRow, { t, labelKey: "autoPermissions", hintKey: "autoPermissionsHint", checked: eff.autoAllowPermissions, disabled: !writable, onChange: (value) => setField("autoAllowPermissions", value) }),
					h(AutoToggleRow, { t, labelKey: "autoQuestions", hintKey: "autoQuestionsHint", checked: eff.autoAnswerQuestions, disabled: !writable, onChange: (value) => setField("autoAnswerQuestions", value) }),
					h(AutoToggleRow, { t, labelKey: "autoPlans", hintKey: "autoPlansHint", checked: eff.autoApprovePlans, disabled: !writable, onChange: (value) => setField("autoApprovePlans", value) }),
					h(AutoToggleRow, { t, labelKey: "workspaceLog", hintKey: "workspaceLogHint", checked: eff.workspaceLog, disabled: !writable, onChange: (value) => setField("workspaceLog", value) }),
					h(
						"div",
						{ className: "dshmfb-retryField" },
						h("span", { className: "dshmfb-retryLabel" }, `${t("autoAuditFile")}: AUTO-MODE.md`),
						h("p", { className: "dshmfb-retryHint" }, t("autoAuditHint")),
					),
					h(
						"div",
						{ className: "dshmfb-footer" },
						h("button", { className: "dshmfb-btn", type: "button", onClick: () => setDraft(null), disabled: !dirty || saving }, t("discard")),
						h("button", { className: "dshmfb-btn dshmfb-primary", type: "button", onClick: save, disabled: !dirty || saving || !writable }, saving ? t("saving") : t("save")),
						dirty && ready && !saving ? h("span", { className: "dshmfb-status" }, t("unsaved")) : null,
					),
					error ? h("p", { className: "dshmfb-error" }, error) : null,
				),
			);
		}

		/**
		 * Runtime status card: per-group catalog counts (from the same llm.models
		 * data the Models page uses), an empty-group warning, and the
		 * protectUnselected toggle that widens the recovery net to requests on
		 * unselected providers.
		 */
		function StatusCard({ t, rows, eff, writable, onToggleProtect, onToggleAllProviders }) {
			const countOf = (id) => {
				const row = rows.find((candidate) => candidate.id === id);
				if (!row) return -1;
				const ids = row.models.map((m) => (m && typeof m === "object" ? m.id : m)).filter((id) => typeof id === "string" && id.length > 0);
				const selected = eff.providerModels?.[id];
				if (!Array.isArray(selected)) return ids.length;
				return ids.filter((id) => selected.includes(id)).length;
			};
			return h(
				"div",
				{ className: "dshmfb-retry" },
				h("div", { className: "dshmfb-retryTitle" }, t("statusTitle")),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"label",
						{ className: "dshmfb-toggle" },
						h("input", {
							type: "checkbox",
							checked: eff.protectUnselected !== false,
							disabled: !writable,
							onChange: (event) => onToggleProtect(event.target.checked),
						}),
						t("statusProtect"),
					),
					h("p", { className: "dshmfb-retryHint" }, t("statusProtectHint")),
				),
				h(
					"div",
					{ className: "dshmfb-retryField" },
					h(
						"label",
						{ className: "dshmfb-toggle" },
						h("input", {
							type: "checkbox",
							checked: eff.allProvidersFallback === true,
							disabled: !writable,
							onChange: (event) => onToggleAllProviders(event.target.checked),
						}),
						t("statusAllProviders"),
					),
					h("p", { className: "dshmfb-retryHint" }, t("statusAllProvidersHint")),
				),
				rows.length > 0
				? h(
						"div",
						{ className: "dshmfb-retryField" },
						h("span", { className: "dshmfb-retryLabel" }, t("statusChain")),
						eff.providers.length > 0
						? h(
								"ul",
								{ className: "dshmfb-list" },
								eff.providers.map((id) => {
									const count = countOf(id);
									return h(
										"li",
										{ key: id, className: "dshmfb-row" },
										h("span", { className: "dshmfb-id" }, id),
										h("span", { className: "dshmfb-badge" }, count >= 0 ? `${count} ${t("statusModels")}` : "?"),
										count === 0 ? h("p", { className: "dshmfb-error" }, t("statusEmptyGroup")) : null,
									);
								}),
							)
						: h("span", { className: "dshmfb-retryHint" }, t("noProviders")),
					)
				: null,
			);
		}

		/**
		 * Activity-log card: fetches the plugin's in-memory event ring from the
		 * host's same-origin /dsh-model-fallback/api/log route (the dsh-market
		 * route contract), newest first, with manual refresh and an optional 5 s
		 * auto-refresh. The log proves whether (and how) the plugin intervened.
		 */
		function LogCard({ t }) {
			const [state, setState] = react.useState({ status: "loading", events: [], error: null, at: null });
			const [auto, setAuto] = react.useState(false);

			const load = react.useCallback(() => {
				setState((previous) => ({ ...previous, status: "loading", error: null }));
				fetch("/dsh-model-fallback/api/log", { cache: "no-store" })
					.then((response) => {
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						return response.json();
					})
					.then((payload) => {
						setState({
							status: "ready",
							events: Array.isArray(payload?.events) ? payload.events : [],
							error: null,
							at: new Date().toISOString(),
						});
					})
					.catch((error) => {
						setState({ status: "error", events: [], error: String((error && error.message) || error), at: new Date().toISOString() });
					});
			}, []);
			react.useEffect(() => {
				load();
			}, [load]);
			react.useEffect(() => {
				if (!auto) return undefined;
				const timer = setInterval(load, 5000);
				return () => clearInterval(timer);
			}, [auto, load]);

			const rows = state.events.map((entry, index) => h("li", {
				key: `${entry.at}-${index}`,
				className: entry.level === "warn" ? "dshmfb-logRow dshmfb-logWarn" : "dshmfb-logRow dshmfb-logInfo",
			}, h("span", { className: "dshmfb-logTime" }, entry.at ? new Date(entry.at).toLocaleTimeString() : ""),
				h("span", { className: "dshmfb-logLevel" }, entry.level === "warn" ? "WARN" : "INFO"),
				h("span", { className: "dshmfb-logMsg" }, entry.message)));

			return h("div", { className: "dshmfb-log" },
				h("div", { className: "dshmfb-retryTitle" }, t("logTitle")),
				h("p", { className: "dshmfb-retryDesc" }, t("logDesc")),
				h("div", { className: "dshmfb-footer" },
				h("button", { className: "dshmfb-btn", type: "button", onClick: load, disabled: state.status === "loading" }, state.status === "loading" ? t("refreshing") : t("logRefresh")),
				h("label", { className: "dshmfb-logAuto" },
					h("input", { type: "checkbox", checked: auto, onChange: (event) => setAuto(event.target.checked) }),
					t("logAuto"),
				),
				state.at ? h("span", { className: "dshmfb-status" }, new Date(state.at).toLocaleTimeString()) : null,
				),
				state.status === "error" ? h("p", { className: "dshmfb-error" }, `${t("logError")}: ${state.error}`) : null,
				state.status === "ready" && state.events.length === 0 ? h("p", { className: "dshmfb-logEmpty" }, t("logEmpty")) : null,
				state.events.length > 0 ? h("ul", { className: "dshmfb-logList" }, rows) : null,
			);
		}

		/**
		 * The "模型回退" settings tab: master switch plus the ordered provider
		 * selection that drives the host-side fallback loop. Reads live through the
		 * bound settings scope; writes go through the same scope with revision
		 * fencing, and the host re-warms its catalogs on every change.
		 */
		function FallbackSection({ controller, api, t }) {
			const [snap, setSnap] = react.useState(controller.getSnapshot());
			react.useEffect(() => controller.subscribe(() => setSnap(controller.getSnapshot())), [controller]);

			const [catalog, setCatalog] = react.useState({ status: "loading", rows: [], error: null });
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);

			const load = react.useCallback(() => {
				setCatalog({ status: "loading", rows: [], error: null });
				loadCatalog(api).then(
					(rows) => setCatalog({ status: "ready", rows, error: null }),
					(error) => setCatalog({ status: "error", rows: [], error: String((error && error.message) || error) }),
				);
			}, [api]);
			react.useEffect(() => {
				load();
			}, [load]);

			const ready = snap.status === "ready";
			const writable = snap.writable === true && snap.mode === "host";
			const base = {
				enabled: ready ? (snap.value ? snap.value.enabled === true : true) : true,
				providers: ready && snap.value && Array.isArray(snap.value.providers) ? snap.value.providers : [],
				protectUnselected: ready && snap.value ? snap.value.protectUnselected !== false : true,
				allProvidersFallback: ready && snap.value ? snap.value.allProvidersFallback === true : false,
				arrears: ready && snap.value && typeof snap.value.arrears === "object" && snap.value.arrears !== null ? snap.value.arrears : {},
				providerModels: ready && snap.value && typeof snap.value.providerModels === "object" && snap.value.providerModels !== null ? snap.value.providerModels : {},
			};
			const eff = draft ?? base;
			const dirty =
				draft !== null &&
				ready &&
				(draft.enabled !== base.enabled ||
					JSON.stringify(draft.providers) !== JSON.stringify(base.providers) ||
					draft.protectUnselected !== base.protectUnselected ||
					draft.allProvidersFallback !== base.allProvidersFallback ||
					JSON.stringify(draft.arrears) !== JSON.stringify(base.arrears) ||
					JSON.stringify(draft.providerModels) !== JSON.stringify(base.providerModels));

			const selectedOrder = new Map(eff.providers.map((id, at) => [id, at]));
			const rows = catalog.rows.slice().sort((a, b) => {
				const ai = selectedOrder.has(a.id) ? selectedOrder.get(a.id) : Number.MAX_SAFE_INTEGER;
				const bi = selectedOrder.has(b.id) ? selectedOrder.get(b.id) : Number.MAX_SAFE_INTEGER;
				return ai - bi;
			});

			const toggle = (id) => {
				setDraft(
					eff.providers.includes(id)
						? { enabled: eff.enabled, providers: eff.providers.filter((provider) => provider !== id), protectUnselected: eff.protectUnselected !== false, allProvidersFallback: eff.allProvidersFallback === true, arrears: eff.arrears, providerModels: eff.providerModels }
						: { enabled: eff.enabled, providers: [...eff.providers, id], protectUnselected: eff.protectUnselected !== false, allProvidersFallback: eff.allProvidersFallback === true, arrears: eff.arrears, providerModels: eff.providerModels },
				);
			};
			const move = (id, delta) => {
				const list = eff.providers.slice();
				const from = list.indexOf(id);
				const to = from + delta;
				if (from < 0 || to < 0 || to >= list.length) return;
				list.splice(to, 0, list.splice(from, 1)[0]);
				setDraft({ enabled: eff.enabled, providers: list, protectUnselected: eff.protectUnselected !== false, allProvidersFallback: eff.allProvidersFallback === true, arrears: eff.arrears, providerModels: eff.providerModels });
			};
			const save = async () => {
				if (!draft || saving) return;
				setSaving(true);
				try {
					await controller.set("enabled", draft.enabled === true);
					await controller.set("providers", draft.providers.slice());
					await controller.set("protectUnselected", draft.protectUnselected !== false);
					await controller.set("allProvidersFallback", draft.allProvidersFallback === true);
					await controller.set("arrears", draft.arrears ?? {});
					await controller.set("providerModels", draft.providerModels ?? {});
					setDraft(null);
				} finally {
					setSaving(false);
				}
			};
			const clearArrears = (accountKey) => {
				const next = { ...(eff.arrears ?? {}) };
				delete next[accountKey];
				setDraft({ ...eff, arrears: next });
				controller.set("arrears", next).catch(() => {});
			};
			const toggleModel = (providerId, modelId) => {
				const ids = catalog.rows.find((row) => row.id === providerId)?.models?.map((m) => (m && typeof m === "object" ? m.id : m)).filter((id) => typeof id === "string" && id.length > 0) ?? [];
				const currentSelected = new Set(eff.providerModels?.[providerId] ?? ids);
				if (currentSelected.has(modelId)) currentSelected.delete(modelId);
				else currentSelected.add(modelId);
				const next = { ...(eff.providerModels ?? {}) };
				if (currentSelected.size === ids.length && ids.every((id) => currentSelected.has(id))) {
					delete next[providerId];
				} else {
					next[providerId] = ids.filter((id) => currentSelected.has(id));
				}
				setDraft({ ...eff, providerModels: next });
			};

			return h(
				"div",
				{ className: "dshmfb" },
				h("h3", { className: "dshmfb-title" }, t("title")),
				h("p", { className: "dshmfb-desc" }, t("desc")),

				// ── Section 1: fallback groups (selection + strategies + save) ──
				h("h4", { className: "dshmfb-sectionLabel" }, t("sectionFallback")),
				h(
					"label",
					{ className: "dshmfb-toggle" },
					h("input", {
						type: "checkbox",
						checked: eff.enabled === true,
						disabled: !writable,
						onChange: (event) => setDraft({ enabled: event.target.checked, providers: eff.providers, protectUnselected: eff.protectUnselected !== false, allProvidersFallback: eff.allProvidersFallback === true, arrears: eff.arrears, providerModels: eff.providerModels }),
					}),
					t("enabled"),
				),
				!writable ? h("p", { className: "dshmfb-hint" }, t("notWritable")) : null,
				catalog.status === "loading" ? h("p", { className: "dshmfb-status" }, t("refreshing")) : null,
				catalog.status === "error"
					? h(
							"div",
							null,
							h("p", { className: "dshmfb-error" }, `${t("loadError")}: ${catalog.error}`),
							h("button", { className: "dshmfb-btn", type: "button", onClick: load }, t("retry")),
						)
					: null,
				catalog.status === "ready" && rows.length === 0 ? h("p", { className: "dshmfb-empty" }, t("noProviders")) : null,
				rows.length > 0
					? h(
							"ul",
							{ className: "dshmfb-list" },
							rows.map((row) =>
								ProviderRow({
									row,
									t,
									selected: selectedOrder.has(row.id),
									order: selectedOrder.get(row.id) ?? 0,
									editable: writable,
									onToggle: toggle,
									onMove: move,
									arrears: eff.arrears,
									providerModels: eff.providerModels,
									onClearArrears: clearArrears,
									onToggleModel: toggleModel,
								}),
							),
						)
					: null,
				// Group-section actions right under the list they govern.
				h(
					"div",
					{ className: "dshmfb-footer" },
					h("button", { className: "dshmfb-btn", type: "button", onClick: load, disabled: catalog.status === "loading" }, catalog.status === "loading" ? t("refreshing") : t("refresh")),
					h("button", { className: "dshmfb-btn", type: "button", onClick: () => setDraft(null), disabled: !dirty || saving }, t("discard")),
					h("button", { className: "dshmfb-btn dshmfb-primary", type: "button", onClick: save, disabled: !dirty || saving || !writable }, saving ? t("saving") : t("save")),
					dirty && ready && !saving ? h("span", { className: "dshmfb-status" }, t("unsaved")) : null,
				),

				// ── Section 2: task retry (own card with its own save) ──
				h("h4", { className: "dshmfb-sectionLabel" }, t("sectionRetry")),
				h(RetrySection, { controller, t, writable }),

				// ── Section 3: runtime status + activity log ──
				h("h4", { className: "dshmfb-sectionLabel" }, t("sectionStatus")),
				h(StatusCard, {
					t,
					rows: catalog.status === "ready" ? catalog.rows : [],
					eff,
					writable,
					onToggleProtect: (value) => setDraft({ enabled: eff.enabled, providers: eff.providers, protectUnselected: value, allProvidersFallback: eff.allProvidersFallback === true, arrears: eff.arrears, providerModels: eff.providerModels }),
					onToggleAllProviders: (value) => setDraft({ enabled: eff.enabled, providers: eff.providers, protectUnselected: eff.protectUnselected !== false, allProvidersFallback: value, arrears: eff.arrears, providerModels: eff.providerModels }),
				}),
				h(LogCard, { t }),
			);
		}
		//#endregion

		/** Session/model services captured at apply() for the switch-visibility helpers. */
		const switchServices = { sessions: null, modelDirectories: null };

		/**
		 * Raise a notice in one session's input area (the same channel the
		 * official queue dock uses), so a model switch is visible in the chat.
		 */
		function notifySession(sessionId, level, text) {
			try {
				const actx = switchServices.sessions?.scope(sessionId);
				const conversation = actx?.get("conversation");
				if (conversation === undefined) return;
				conversation.input.for(actx).notify(level, text);
			} catch {
				// The session may have closed between the event and the notice.
			}
		}

		/**
		 * Sync the session's model selector to the model that actually took over:
		 * `directory.select({ provider, model })` persists the choice, so the
		 * input-bar model display follows the switch instead of showing a model
		 * that just failed.
		 */
		async function syncModelSelection(sessionId, modelSpec) {
			const slashAt = modelSpec.indexOf("/");
			if (slashAt <= 0) return;
			const provider = modelSpec.slice(0, slashAt);
			const model = modelSpec.slice(slashAt + 1);
			const directory = switchServices.modelDirectories?.directoryFor(sessionId);
			if (directory === undefined) return;
			try {
				await directory.load();
				const state = directory.store.getSnapshot();
				for (const group of state.groups) {
					if (group.id !== provider) continue;
					const hit = (group.models ?? []).find((candidate) => candidate.id === model);
					if (hit === undefined) return; // not a selectable entry — leave the display alone
					await directory.select({ provider, model, ...(hit.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: hit.reasoning.defaultEffort }) });
					return;
				}
			} catch {
				// Best-effort: the switch itself already happened; only the display sync failed.
			}
		}

		/** Inline icon: Lucide "bot" (autopilot / full-auto). */
		function IconBot({ className }) {
			return h(
				"svg",
				{
					className,
					xmlns: "http://www.w3.org/2000/svg",
					width: "16",
					height: "16",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					strokeLinecap: "round",
					strokeLinejoin: "round",
				},
				h("path", { d: "M12 8V4H8" }),
				h("rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }),
				h("path", { d: "M2 14h2" }),
				h("path", { d: "M20 14h2" }),
				h("path", { d: "M15 13v2" }),
				h("path", { d: "M9 13v2" }),
			);
		}

		/** Inline icon: Lucide "layers" (model fallback / candidate pool). */
		function IconLayers({ className }) {
			return h(
				"svg",
				{
					className,
					xmlns: "http://www.w3.org/2000/svg",
					width: "16",
					height: "16",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					strokeLinecap: "round",
					strokeLinejoin: "round",
				},
				h("path", { d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" }),
				h("path", { d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" }),
				h("path", { d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" }),
			);
		}

		/** One icon-only half of the combined input-bar capsule. */
		function HalfPill({ controller, t, onKey, offKey, busyKey, icon: Icon }) {
			const [snap, setSnap] = react.useState(controller.getSnapshot());
			react.useEffect(() => controller.subscribe(() => setSnap(controller.getSnapshot())), [controller]);

			const enabled = snap.status === "ready" && snap.value && typeof snap.value === "object" ? snap.value.enabled === true : false;
			const writable = snap.writable === true && snap.mode === "host";
			const [busy, setBusy] = react.useState(false);

			const toggle = async () => {
				if (!writable || busy) return;
				setBusy(true);
				try {
					await controller.set("enabled", !enabled);
					setSnap(controller.getSnapshot());
				} finally {
					setBusy(false);
					setSnap(controller.getSnapshot());
				}
			};

			const title = !writable ? t("notWritable") : busy ? t(busyKey) : enabled ? t(onKey) : t(offKey);
			return h(
				"button",
				{
					type: "button",
					className: enabled ? "dshmfb-halfPill on" : "dshmfb-halfPill",
					disabled: !writable || busy || snap.status !== "ready",
					onClick: toggle,
					title,
					"aria-pressed": enabled,
					"aria-label": title,
				},
				h(Icon, null),
			);
		}

		/**
		 * Combined capsule in the composer's input bar (conversation.input.right —
		 * the same row as the send button). Left half toggles model fallback, right
		 * half toggles full-auto. Icons replace text; active halves light up.
		 * Polls the event ring so model switches and full-auto decisions stay
		 * visible in the conversation.
		 */
		function ModelFallbackPill({ controller, autoController, t, sessionId }) {
			// Switch visibility: poll the event ring; every NEW "switching to …"
			// event raises a chat notice AND syncs the session's model selector to
			// the model that actually took over (the display follows reality).
			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
				let lastSeenAt = null;
				const poll = async () => {
					try {
						const response = await fetch("/dsh-model-fallback/api/log", { cache: "no-store" });
						if (!response.ok) return;
						const payload = await response.json();
						const events = Array.isArray(payload?.events) ? payload.events : [];
						const fresh = lastSeenAt === null ? [] : events.filter((entry) => entry.at > lastSeenAt);
						if (lastSeenAt === null) {
							// First poll only anchors the watermark — no historical spam.
							lastSeenAt = events.length > 0 ? events[0].at : new Date(0).toISOString();
							return;
						}
						if (fresh.length > 0) lastSeenAt = fresh[0].at;
						for (const entry of fresh.reverse()) {
							const switchMatch = /switching to ([^;)]+)$/.exec(entry.message) ?? /switching to ([^;)]+?);/.exec(entry.message);
							const recoveredMatch = /request recovered on ([^ ]+) after/.exec(entry.message);
							const autoAllowed = /auto-answered \((.+)\); logged/.exec(entry.message);
							const autoPermission = /permission for "([^"]+)" auto-allowed/.exec(entry.message);
							const model = switchMatch?.[1] ?? recoveredMatch?.[1];
							if (model !== undefined) {
								const from = String(entry.message.match(/^(?:model-fallback: )?([^ ]+) failed/) ?? ["", ""])[1];
								const text = switchMatch
									? t("switchNotify").replace("{from}", from).replace("{to}", model)
									: t("switchRecovered").replace("{model}", model);
								notifySession(sessionId, entry.level === "warn" ? "warn" : "info", text);
								syncModelSelection(sessionId, model).catch(() => {});
								continue;
							}
							// Full-auto transparency: surface every automatic decision in
							// the conversation so the user sees exactly what was allowed.
							if (autoAllowed) {
								notifySession(sessionId, "info", `${t("autoAnsweredNotice")}: ${autoAllowed[1]}`);
								continue;
							}
							if (autoPermission) {
								notifySession(sessionId, "info", `${t("autoAllowedNotice")}: ${autoPermission[1]}`);
							}
						}
					} catch {
						// The log route may be briefly unavailable; the next tick retries.
					}
				};
				void poll();
				const timer = setInterval(poll, 4000);
				return () => {
					clearInterval(timer);
				};
			}, [sessionId, t]);

			return h(
				"div",
				{ className: "dshmfb-comboPill", role: "group", "aria-label": `${t("autoNav")} / ${t("nav")}` },
				h(HalfPill, { controller: autoController, t, onKey: "autoPillOn", offKey: "autoPillOff", busyKey: "autoPillBusy", icon: IconBot }),
				h(HalfPill, { controller, t, onKey: "fallbackPillOn", offKey: "fallbackPillOff", busyKey: "fallbackPillBusy", icon: IconLayers }),
			);
		}

		//#region lib/types/client/index.js
		/** Services this client plugin requires (cordis fiber inject). */
		const inject = ["slots", "locale", "connection", "settingsScope"];

		/**
		 * Register the dictionaries, the namespace settings scope, and the standalone
		 * Settings tab section.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ensureCss();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "model-fallback: dictionaries");
			const t = ctx.locale.bind(NS);
			const connection = ctx.get("connection");
			const settingsScope = ctx.get("settingsScope");
			try {
				ctx.inject(["sessions", "modelDirectories"], (scope) => {
					switchServices.sessions = scope.sessions;
					switchServices.modelDirectories = scope.modelDirectories;
				});
			} catch {
				// Without these services the pill still toggles; only the switch
				// notices and selector sync stay off.
			}
			const controller = settingsScope.bind({ namespace: NS });
			const autoController = settingsScope.bind({ namespace: "model-fallback-auto" });
			const injected = () => ({ controller, api: connection.api });
			const injectedAuto = () => ({ controller: autoController, api: connection.api });
			ctx.slots.inject("conversation.input.right", () =>
				ctx.slots.register(
					{
						name: "conversation.input.right",
						id: "model-fallback-auto-drive",
						order: 5,
						locale: NS,
						inject: (sessionId) => ({ controller, autoController, t, sessionId }),
					},
					ModelFallbackPill,
				),
			);
			ctx.slots.inject("settings.section", () => {
				ctx.slots.register(
					{
						name: "settings.section",
						id: "model-fallback",
						order: 20,
						label: () => t("nav"),
						locale: NS,
						inject: injected,
					},
					FallbackSection,
				);
				ctx.slots.register(
					{
						name: "settings.section",
						id: "model-fallback-auto",
						order: 21,
						label: () => t("autoNav"),
						locale: NS,
						inject: injectedAuto,
					},
					AutoModeSection,
				);
			});
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
