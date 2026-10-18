/**
 * dsh-editing-message, Client half (dsh v0.2.0-rc.2).
 *
 * Что делает плагин. Под КАЖДЫМ сообщением пользователя (рядом с кнопкой
 * «Копировать») появляются ещё две кнопки-иконки:
 *
 *  1. «Редактировать» — сообщение превращается в редактор. После отправки
 *     плагин создаёт ветку сессии (fork) ровно ДО этого сообщения, отправляет
 *     в неё изменённый текст и открывает ветку. Старый ответ модели в ветке
 *     отсутствует — модель «забывает» его и отвечает заново на изменённое
 *     сообщение. Исходная сессия не меняется.
 *
 *  2. «Перегенерировать» — то же самое, но без правки: текст сообщения
 *     отправляется повторно, модель отвечает заново.
 *
 * Механика — официальные клиентские API: `ctx.sessions.fork({ sessionId,
 * atSeq })` (тот же механизм, что у штатной кнопки «ветка»), `session.prompt
 * (content, 'queue')`, `ctx.uiWorkspace.openSession(childId)`.
 *
 * Точка монтирования: слот `conversation.chat.node` с ключом `user`
 * (переиспользование ключа заменяет штатный рендерер — документированное
 * поведение keyed-слота). Штатный вид сообщения воспроизводится собственным
 * кодом плагина: та же геометрия, те же токены темы, свои иконки (никаких
 * require харнесс-пакетов, кроме react).
 *
 * Сервисы берутся мягко, через `ctx.get(...)` с проверкой (рекомендация
 * инспектора клиента): отсутствие `sessions`/`uiWorkspace`/`slots` не роняет
 * активацию — плагин остаётся неактивным, штатный рендер работает.
 *
 * Отказоустойчивость ( эталон — dsh-agents-board ):
 *  - `apply` обёрнут в try/catch: падение активации гасит только плагин;
 *  - каждая регистрация слота — в try/catch: падает одна регистрация, а не
 *    весь клиентский модуль;
 *  - компонент строки обёрнут в React-граничный класс: при сбое отрисовки
 *    показывается простой запасной бабл, чат не падает;
 *  - все действия оборачиваются в try/catch с сообщением об ошибке в строке;
 *  - при отсутствии нужных сервисов (`sessions.fork` и т.п.) регистрация не
 *    выполняется вовсе — остаётся штатный рендер сообщений.
 */

window.__ModuleLoader__.load({
	id: 'dsh-editing-message',
	factory(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react = require('react');
		let h = react.createElement;

		/** Dictionary namespace owned by this plugin. */
		const NS = 'editing-message';

		/** English dictionary — the fallback terminus of the locale chain. */
		const en = {
			'actions.edit': 'Edit message',
			'actions.editHint': 'Edit: the chat continues with the changed message and the model re-answers from that point',
			'actions.regen': 'Regenerate',
			'actions.regenHint': 'Regenerate: resend this message and get a fresh answer',
			'copy': 'Copy',
			'copied': 'Copied',
			'editor.title': 'The chat continues from the changed message; later answers are dropped (the original stays in the archive).',
			'editor.save': 'Save & resend',
			'editor.saving': 'Saving…',
			'editor.cancel': 'Cancel',
			'editor.errorEmpty': 'The message must not be empty.',
			'editor.errorBusy': 'Wait: another action is still running in this session.',
			'editor.errorGeneric': 'The action failed. The source chat is unchanged.',
			'references': 'References: {labels}',
		};

		/** Russian dictionary — key-identical to the English source of truth. */
		const ru = {
			'actions.edit': 'Редактировать сообщение',
			'actions.editHint': 'Редактировать: чат продолжится с изменённого сообщения, и модель ответит заново от этой точки',
			'actions.regen': 'Перегенерировать',
			'actions.regenHint': 'Перегенерировать: отправить это сообщение повторно и получить свежий ответ',
			'copy': 'Копировать',
			'copied': 'Скопировано',
			'editor.title': 'Чат продолжится с изменённого сообщения; последующие ответы будут отброшены (исходник останется в архиве).',
			'editor.save': 'Сохранить и отправить',
			'editor.saving': 'Отправка…',
			'editor.cancel': 'Отмена',
			'editor.errorEmpty': 'Сообщение не может быть пустым.',
			'editor.errorBusy': 'Подождите: в этой сессии ещё выполняется предыдущее действие.',
			'editor.errorGeneric': 'Действие не удалось. Исходный чат не изменился.',
			'references': 'Цитаты: {labels}',
		};

		/** Local fallback when the locale seat is unavailable. */
		function fallbackText(key, params) {
			let text = ru[key] !== undefined ? ru[key] : en[key] !== undefined ? en[key] : key;
			if (params) {
				for (const name of Object.keys(params)) {
					text = text.split('{' + name + '}').join(String(params[name]));
				}
			}
			return text;
		}

		/** Wrap the locale seat: never throws, substitutes params on failure. */
		function makeT(t) {
			if (typeof t !== 'function') return fallbackText;
			return (key, params) => {
				try {
					const text = t(key, params);
					if (typeof text === 'string' && text !== '' && text !== key) return text;
				} catch {
					// Fall through to the local dictionary.
				}
				return fallbackText(key, params);
			};
		}

		//#region stylesheet
		const css = '.dsem-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}'
			+ '.dsem-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;'
			+ 'max-width:min(calc(var(--dsh-chat-content-width,748px)*0.702),82%)}'
			+ '.dsem-attachRow{display:flex;flex-wrap:wrap;justify-content:flex-end;max-width:100%;gap:8px}'
			+ '.dsem-bubble{max-width:100%;background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);'
			+ 'padding:10px 16px;font-size:var(--dsh-content-font-size,14px);'
			+ 'line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);'
			+ 'white-space:pre-wrap;word-break:break-word}'
			+ '.dsem-referenceSummary{color:var(--dsw-alias-label-tertiary);'
			+ 'font-size:var(--dsh-content-font-size-secondary,13px);'
			+ 'line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}'
			+ '.dsem-fileCard{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:8px 12px;'
			+ 'border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);'
			+ 'background:var(--dsw-specific-input-major,transparent);box-sizing:border-box}'
			+ '.dsem-fileName{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;'
			+ 'color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}'
			+ '.dsem-actions{display:flex;align-items:center;gap:8px;height:calc(28px + var(--dsh-content-font-delta,0px))}'
			+ '.dsem-time{padding-right:12px;font-size:var(--dsh-content-font-size-secondary,13px);'
			+ 'line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap}'
			+ '.dsem-action{display:inline-flex;align-items:center;justify-content:center;'
			+ 'width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));'
			+ 'padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;'
			+ 'color:var(--dsw-alias-label-tertiary);cursor:pointer}'
			+ '.dsem-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));'
			+ 'height:calc(15px + var(--dsh-content-font-delta,0px))}'
			+ '.dsem-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}'
			+ '.dsem-action:disabled{cursor:default;opacity:.4}'
			+ '.dsem-action:disabled:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}'
			+ '.dsem-editor{box-sizing:border-box;width:100%;min-height:96px;max-height:340px;resize:vertical;'
			+ 'padding:10px 16px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);'
			+ 'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;'
			+ 'font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}'
			+ '.dsem-editor:focus{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:0}'
			+ '.dsem-editorBar{display:flex;align-items:center;gap:8px;width:100%}'
			+ '.dsem-editorNote{flex:1;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-align:left}'
			+ '.dsem-save{display:inline-flex;align-items:center;height:28px;padding:0 12px;border:none;'
			+ 'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-label-primary);'
			+ 'color:var(--dsw-alias-bg-base);font-size:13px;cursor:pointer}'
			+ '.dsem-save:disabled{opacity:.4;cursor:default}'
			+ '.dsem-save:hover:not(:disabled){background:var(--dsw-alias-label-secondary)}'
			+ '.dsem-cancel{display:inline-flex;align-items:center;height:28px;padding:0 12px;'
			+ 'border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);'
			+ 'background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer}'
			+ '.dsem-cancel:hover{background:var(--dsw-alias-interactive-bg-hover)}'
			+ '.dsem-error{max-width:100%;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px;'
			+ 'text-align:right;word-break:break-word}'
			+ '@media (hover:hover){'
			+ ":is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering']):has("
			+ "~ :is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering'])) .dsem-actions{opacity:0;transition:opacity 80ms ease}"
			+ ":is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering']):has("
			+ "~ :is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering'])):hover .dsem-actions,"
			+ ":is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering']):has("
			+ "~ :is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering'])):focus-within .dsem-actions{opacity:1}}"
			+ '.dsem-visuallyHidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}';
		const cssTagId = 'dsh-editing-message/client.css';
		function injectStyles() {
			if (typeof document !== 'object' || document === null) return;
			if (document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') !== null) return;
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-editing-message';
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region runtime state
		/** The activation context; services resolve lazily through it. */
		let rootCtx = null;
		/** Memoized lazy service reads (resolve once, then reuse). */
		const services = { sessions: null, uiWorkspace: null };
		/** Session ids with an in-flight fork/prompt: re-entry is refused. */
		const busy = new Set();
		/** Editor drafts by `${sessionId}:${nodeKey}`: survive re-renders. */
		const drafts = new Map();
		//#endregion

		//#region small helpers
		/**
		 * Resolve a client service lazily through the activation context. Module
		 * load order is not guaranteed — our bundle may activate BEFORE the
		 * sessions controller — so no service is required at apply() time.
		 * The first successful read is memoized; null means "still unavailable".
		 */
		function lazyService(key) {
			if (services[key] !== null) return services[key];
			if (rootCtx === null) return null;
			const value = readService(rootCtx, key);
			if (value !== null) services[key] = value;
			return value;
		}

		/** The sessions face when (and only when) its fork/using verbs exist. */
		function sessionsService() {
			const sessions = lazyService('sessions');
			if (sessions === null) return null;
			if (typeof sessions.fork !== 'function' || typeof sessions.using !== 'function') return null;
			return sessions;
		}

		/** The uiWorkspace face when (and only when) its open verb exists. */
		function uiWorkspaceService() {
			const ui = lazyService('uiWorkspace');
			if (ui === null) return null;
			if (typeof ui.openSession !== 'function') return null;
			return ui;
		}

		function isSafeSeq(value) {
			return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
		}

		/** The durable event seq of a user message node (data.seq is exact). */
		function messageSeq(node) {
			const seq = node && node.data ? node.data.seq : undefined;
			return isSafeSeq(seq) ? seq : undefined;
		}

		/** Joined text of a message content block list. */
		function messageText(data) {
			if (!data || !Array.isArray(data.content)) return '';
			const texts = [];
			for (const block of data.content) {
				const b = block && typeof block === 'object' ? block : {};
				if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
			}
			return texts.join('');
		}

		/**
		 * Split message content into renderable parts: joined text, durable image
		 * sources (for the host gallery renderer), file attachments, and unknown
		 * blocks (rendered as collapsed JSON).
		 */
		function contentParts(content) {
			const images = [];
			const files = [];
			const rest = [];
			if (!Array.isArray(content)) return { images, files, rest };
			for (const block of content) {
				const b = block && typeof block === 'object' ? block : {};
				if (b.type === 'image' && b.attachment !== undefined) images.push({ attachment: b.attachment });
				else if (b.type === 'file' && b.attachment !== undefined) files.push(b.attachment);
				else if (b.type !== 'text') rest.push(block);
			}
			return { images, files, rest };
		}

		function fileSizeText(bytes) {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
			if (bytes < 1024) return bytes + ' B';
			if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
			return Math.round(bytes / (1024 * 1024)) + ' MB';
		}

		/** Compact local timestamp: same day → HH:mm, else DD.MM HH:mm. */
		function formatClock(ms) {
			const d = new Date(ms);
			if (!Number.isFinite(d.getTime())) return '';
			const hh = String(d.getHours()).padStart(2, '0');
			const mm = String(d.getMinutes()).padStart(2, '0');
			const clock = hh + ':' + mm;
			const now = new Date();
			if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
				&& d.getDate() === now.getDate()) return clock;
			return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + clock;
		}

		/** Clipboard write with a textarea fallback for non-secure contexts. */
		function writeClipboard(text) {
			try {
				if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					return navigator.clipboard.writeText(text).then(() => true, () => copyFallback(text));
				}
			} catch {
				// Fall through to the fallback path.
			}
			return Promise.resolve(copyFallback(text));
		}

		function copyFallback(text) {
			try {
				const area = document.createElement('textarea');
				area.value = text;
				area.style.position = 'fixed';
				area.style.opacity = '0';
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand('copy');
				area.remove();
				return ok;
			} catch {
				return false;
			}
		}

		function errorMessageOf(error, t) {
			const raw = error && typeof error === 'object' && typeof error.message === 'string' && error.message !== ''
				? error.message : String(error === undefined ? '' : error);
			const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
			return code !== '' ? code + (raw !== '' ? ': ' + raw : '') : (raw !== '' ? raw : t('editor.errorGeneric'));
		}
		//#endregion

		//#region icons (plugin-owned; no harness icon imports)
		function SvgIcon(children) {
			return h('svg', {
				width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
				'aria-hidden': true, focusable: false, style: { display: 'block' },
			}, children);
		}
		function IconCopy() {
			return SvgIcon([
				h('rect', { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5', stroke: 'currentColor', strokeWidth: '1.3' }),
				h('path', { d: 'M3.5 10.5v-6A1.5 1.5 0 0 1 5 3h6', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
			]);
		}
		function IconCheck() {
			return SvgIcon(h('path', {
				d: 'M3.5 8.5 6.5 11.5 12.5 4.5', stroke: 'currentColor',
				strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round',
			}));
		}
		function IconEdit() {
			return SvgIcon([
				h('path', {
					d: 'M3 13.2l.8-3 6.9-6.9a1.4 1.4 0 0 1 2 2l-6.9 6.9L3 13.2Z',
					stroke: 'currentColor', strokeWidth: '1.3', strokeLinejoin: 'round',
				}),
				h('path', { d: 'M9.8 4.2l2 2', stroke: 'currentColor', strokeWidth: '1.3' }),
			]);
		}
		function IconRegen() {
			return SvgIcon([
				h('path', {
					d: 'M13.5 8A5.5 5.5 0 1 1 11.7 3.9', stroke: 'currentColor',
					strokeWidth: '1.3', strokeLinecap: 'round',
				}),
				h('path', {
					d: 'M13.9 1.6v3h-3', stroke: 'currentColor',
					strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round',
				}),
			]);
		}
		//#endregion

		//#region service operations
		/** Open a session in the workspace; a failure leaves the view as-is. */
		function openSession(sessionId) {
			try {
				const ui = uiWorkspaceService();
				if (ui !== null) ui.openSession(sessionId);
				else console.error('[editing-message] uiWorkspace.openSession is unavailable; the continuation stays in the sidebar.');
			} catch (error) {
				console.error('[editing-message] openSession failed; the fork stays in the sidebar.', error);
			}
		}

		/**
		 * Archive the source session after a successful edit. The fork child
		 * carries the SAME title and the sidebar places a new fork right before
		 * its source, so archiving the source leaves ONE row in the chat's old
		 * position — the flow feels like the same chat continued in place. The
		 * original (with the old answers) stays recoverable in the "show
		 * archived" sidebar filter. A refusal (running work) is contained: both
		 * chats simply stay visible.
		 */
		function archiveSource(sessionId) {
			try {
				const ui = uiWorkspaceService();
				if (ui === null || typeof ui.archiveSession !== 'function') {
					console.error('[editing-message] uiWorkspace.archiveSession is unavailable; the source chat stays active.');
					return;
				}
				// Fire-and-forget: the view already shows the child; an archive
				// refusal must not fail the edit the user just made.
				Promise.resolve()
					.then(() => ui.archiveSession(sessionId, { stopActivity: true }))
					.catch((archiveError) => {
						console.error('[editing-message] archiving the source chat failed; both chats stay in the sidebar.', archiveError);
					});
			} catch (error) {
				console.error('[editing-message] archive call failed; the source chat stays active.', error);
			}
		}

		/**
		 * Copy the source chat's chat-background photo config to the
		 * continuation session. dsh-background stores its per-chat photo under
		 * the session id, so a fork starts bare and the photo would be lost —
		 * the very reason "no new chat" was requested. Best effort: when the
		 * background plugin is absent, the fetch fails, or the source has no
		 * photo, the flow continues unchanged and nothing is copied.
		 * @returns {Promise<boolean>} whether any config was copied.
		 */
		function copyBackgroundToChild(sourceId, childId) {
			return new Promise((resolve) => {
				let settled = false;
				const finish = (value) => { if (settled === false) { settled = true; resolve(value === true); } };
				try {
					if (typeof fetch !== 'function') { finish(false); return; }
					fetch('/chat-background/state').then((response) => {
						if (response.ok !== true) throw new Error('state ' + String(response.status));
						return response.json();
					}).then((data) => {
						const map = data !== null && typeof data === 'object' && data.sessions !== null && typeof data.sessions === 'object'
							? data.sessions : {};
						const pair = map[sourceId] !== null && typeof map[sourceId] === 'object' ? map[sourceId] : null;
						if (pair === null) { finish(false); return; }
						const copies = [];
						const devices = pair.desktop !== undefined || pair.mobile !== undefined
							? ['desktop', 'mobile']
							: ['desktop'];
						for (const device of devices) {
							const cfg = pair[device];
							if (cfg === null || cfg === undefined || typeof cfg !== 'object') continue;
							copies.push(fetch('/chat-background/session', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({ sessionId: childId, device, config: cfg }),
							}).then((response) => response.ok === true).catch(() => false));
						}
						if (copies.length === 0) { finish(false); return; }
						Promise.all(copies).then((results) => {
							const copied = results.some((ok) => ok === true);
							if (copied === true) console.error('[editing-message] background photo copied to the continuation session.');
							finish(copied);
						});
					}).catch(() => finish(false));
				} catch {
					finish(false);
				}
			});
		}

		/**
		 * Continue the session "in place" through the same-chat fork: cut the
		 * log at the inclusive boundary `atSeq` (the event just before the
		 * target message), send `text` into the cut, open it, and archive the
		 * source. The child inherits the same title and the source's sidebar
		 * position, so the chat visibly continues; the model never sees the
		 * original message or its old answers. The append-only session log has
		 * no public history-rewrite verb — this is the same mechanism the
		 * sidebar's own Fork uses, automated end to end.
		 * @returns {Promise<string>} the continuation session id.
		 */
		function forkAndPrompt(sessionId, atSeq, text) {
			// Lazy resolution: the sessions controller may activate after this
			// bundle (combo order is not guaranteed), so the verbs are looked
			// up on first use, not at page boot.
			const sessions = sessionsService();
			if (sessions === null) {
				return Promise.reject(new Error('The client sessions service is not ready — try again in a second.'));
			}
			return Promise.resolve()
				.then(() => sessions.fork({ sessionId, atSeq }))
				.then((childId) => Promise.all([
					childId,
					// Copy the chat photo BEFORE the view switches, so the
					// continuation opens with the chat's look already in place.
					copyBackgroundToChild(sessionId, childId),
				]).then(([id, copied]) => ({ id, copied })))
				.then(({ id: childId, copied }) => sessions.using(childId, { source: 'mainView' }, (reference) => {
					const session = reference.binding && reference.binding.session;
					if (!session || typeof session.prompt !== 'function') {
						throw new Error('session.prompt is unavailable');
					}
					return session.prompt([{ type: 'text', text }], 'queue').then((result) => {
						if (result && result.ok === false) {
							const error = new Error(result.error && result.error.message ? result.error.message : 'prompt rejected');
							error.code = result.error && result.error.code;
							throw error;
						}
						return { childId, copied };
					});
				}))
				.then(({ childId, copied }) => {
					openSession(childId);
					archiveSource(sessionId);
					if (copied === true) {
						// The running page's background store only refreshes at
						// page boot: one automatic reload paints the inherited
						// photo right away (the streamed answer continues —
						// the transcript lives server-side).
						setTimeout(() => {
							try { window.location.reload(); } catch (reloadError) {
								console.error('[editing-message] automatic reload failed; press F5 to see the copied background.', reloadError);
							}
						}, 1200);
					}
					return childId;
				});
		}

		/** One edit-and-resend action; refuses re-entry for the same session. */
		function runEdit(sessionId, atSeq, text) {
			if (busy.has(sessionId)) return Promise.reject(new Error('busy'));
			busy.add(sessionId);
			return forkAndPrompt(sessionId, atSeq, text).finally(() => { busy.delete(sessionId); });
		}
		//#endregion

		//#region row components
		/**
		 * Error boundary: a crash inside one message row degrades that row to the
		 * plain fallback bubble instead of blanking the slot entry.
		 */
		class SafeBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.error('[editing-message] row render failed; the plain fallback is shown.', error);
			}
			render() {
				return this.state.failed === true ? this.props.fallback : this.props.children;
			}
		}

		/** The absolutely minimal fallback: plain right-aligned bubble. */
		function PlainBubble(props) {
			try {
				const text = messageText(props.data);
				return h('div', { className: 'dsem-row' },
					h('div', { className: 'dsem-stack' },
						h('div', { className: 'dsem-bubble' }, text)));
			} catch (error) {
				console.error('[editing-message] fallback render failed.', error);
				return null;
			}
		}

		/** Attachment row: durable images through the host gallery, own file chips. */
		function AttachmentRow(props) {
			const { images, files } = props.parts;
			if (images.length === 0 && files.length === 0) return null;
			const compact = images.length + files.length > 1;
			const children = [];
			for (let i = 0; i < images.length; i++) {
				if (typeof props.renderMessageImages === 'function') {
					try {
						children.push(h(react.Fragment, { key: 'img:' + i },
							props.renderMessageImages({ images: [images[i]], align: 'end', compact })));
					} catch (error) {
						console.error('[editing-message] image render failed.', error);
					}
				}
			}
			for (let i = 0; i < files.length; i++) {
				const file = files[i] && typeof files[i] === 'object' ? files[i] : {};
				const name = typeof file.name === 'string' && file.name !== '' ? file.name : 'file';
				const size = fileSizeText(file.bytes);
				children.push(h('span', { key: 'file:' + i, className: 'dsem-fileCard', title: name },
					h('span', { className: 'dsem-fileName' }, name + (size !== '' ? ' · ' + size : ''))));
			}
			return h('div', { className: 'dsem-attachRow', 'data-message-attachments': true }, children);
		}

		/** Unknown extra content blocks as a collapsed JSON disclosure. */
		function RestBlocks(props) {
			if (props.rest.length === 0) return null;
			return h('details', { className: 'dsem-fileCard' },
				h('summary', { className: 'dsem-fileName' }, 'JSON'),
				h('pre', { style: { margin: '4px 0 0', fontSize: '11px', maxHeight: '200px', overflow: 'auto' } },
					JSON.stringify(props.rest, null, 2).slice(0, 4000)));
		}

		/** The inline editor that replaces the bubble while editing. */
		function EditorCard(props) {
			const [value, setValue] = react.useState(props.initial);
			const [pending, setPending] = react.useState(false);
			const [error, setError] = react.useState(null);
			const areaRef = react.useRef(null);
			react.useEffect(() => {
				const el = areaRef.current;
				if (el && typeof el.focus === 'function') {
					el.focus();
					try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* older engines */ }
				}
			}, []);
			const submit = () => {
				if (pending === true) return;
				const text = value.trim();
				if (text === '') { setError(props.t('editor.errorEmpty')); return; }
				setPending(true);
				setError(null);
				props.onSubmit(text).then(() => {
					// The workspace switches to the fork; this row unmounts.
				}, (submitError) => {
					setPending(false);
					const message = submitError && submitError.message === 'busy'
						? props.t('editor.errorBusy') : errorMessageOf(submitError, props.t);
					setError(message);
					console.error('[editing-message] edit failed; the source session is unchanged.', submitError);
				});
			};
			const onKeyDown = (event) => {
				if (event.key === 'Escape') { event.preventDefault(); props.onCancel(); return; }
				if ((event.ctrlKey === true || event.metaKey === true) && event.key === 'Enter') {
					event.preventDefault();
					submit();
				}
			};
			return h('div', { className: 'dsem-stack' },
				h('textarea', {
					ref: areaRef,
					className: 'dsem-editor',
					value,
					'aria-label': props.t('actions.edit'),
					onChange: (event) => { setValue(event.target.value); props.onDraftChange(event.target.value); },
					onKeyDown,
					spellCheck: false,
				}),
				h('div', { className: 'dsem-editorBar' },
					h('span', { className: 'dsem-editorNote' }, props.t('editor.title')),
					h('button', {
						type: 'button', className: 'dsem-save', disabled: pending === true,
						onClick: submit,
					}, pending === true ? props.t('editor.saving') : props.t('editor.save')),
					h('button', {
						type: 'button', className: 'dsem-cancel', disabled: pending === true,
						onClick: props.onCancel,
					}, props.t('editor.cancel'))),
				error !== null ? h('span', { className: 'dsem-error', role: 'status' }, error) : null);
		}

		/**
		 * The icon row under the bubble: clock, copy, edit, regenerate — the edit
		 * and regenerate buttons sit right after the copy button, where the host
		 * projects its per-message actions.
		 */
		function MessageActionsRow(props) {
			const [copied, setCopied] = react.useState(false);
			const timerRef = react.useRef(null);
			react.useEffect(() => () => {
				if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
			}, []);
			const onCopy = () => {
				if (copied === true || props.text === '') return;
				writeClipboard(props.text).then((ok) => {
					if (ok !== true) return;
					setCopied(true);
					if (timerRef.current !== null) clearTimeout(timerRef.current);
					timerRef.current = setTimeout(() => {
						timerRef.current = null;
						setCopied(false);
					}, 1000);
				});
			};
			const copyLabel = copied === true ? props.t('copied') : props.t('copy');
			const busy = props.busy === true;
			const canRegen = busy !== true && isSafeSeq(props.atSeq);
			return h('div', { className: 'dsem-actions' },
				props.time !== undefined ? h('span', { className: 'dsem-time' }, formatClock(props.time)) : null,
				h('button', {
					type: 'button', className: 'dsem-action', 'aria-label': copyLabel, title: copyLabel,
					onClick: onCopy,
				}, copied === true ? h(IconCheck) : h(IconCopy)),
				h('button', {
					type: 'button', className: 'dsem-action', 'aria-label': props.t('actions.edit'),
					title: props.t('actions.editHint'), disabled: busy === true,
					onClick: props.onEdit,
				}, h(IconEdit)),
				h('button', {
					type: 'button', className: 'dsem-action', 'aria-label': props.t('actions.regen'),
					title: props.t('actions.regenHint'), disabled: canRegen !== true,
					onClick: props.onRegen,
				}, h(IconRegen)));
		}

		/**
		 * The replaced `user`/`steering` Chat node renderer. Hooks stay
		 * unconditional; everything risky is guarded, and SafeBoundary degrades
		 * a crash to the plain fallback bubble.
		 */
		function EditingMessageView(props) {
			const data = props.node && props.node.data ? props.node.data : null;
			const [editing, setEditing] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			if (data === null) return null;
			const t = makeT(props.t);
			const draftKey = (props.sessionId !== undefined ? String(props.sessionId) : '?') + ':' + String(props.node.key);
			const parts = contentParts(data.content);
			const text = messageText(data);
			// Fork point: the inclusive boundary BEFORE this message's event
			// (turn/start precedes user/message in the log), so the fork inherits
			// everything up to it and none of the dropped tail. The model in the
			// fork never sees the original message or its old answers.
			const eventSeq = messageSeq(props.node);
			const atSeq = eventSeq === undefined || eventSeq < 1 ? undefined : eventSeq - 1;
			// Not gated on the sessions service: load order is not guaranteed,
			// and a missing service surfaces as a clear click-time error.
			const editAvailable = isSafeSeq(atSeq);
			const beginEdit = () => {
				setError(null);
				setEditing(true);
			};
			const cancelEdit = () => {
				setEditing(false);
				setError(null);
				drafts.delete(draftKey);
			};
			const changeDraft = (value) => {
				drafts.set(draftKey, value);
			};
			const submitEdit = (nextText) => {
				drafts.delete(draftKey);
				return runEdit(props.sessionId, atSeq, nextText);
			};
			const regenerate = () => {
				if (busy === true || editAvailable !== true) return;
				setBusy(true);
				setError(null);
				// The same busy-guarded core as edit: a double click (here or on
				// another row of the same session) is refused while in flight.
				runEdit(props.sessionId, atSeq, text).then(() => {
					// The workspace switched to the fork.
				}, (regenError) => {
					setBusy(false);
					setError(regenError && regenError.message === 'busy'
						? t('editor.errorBusy') : errorMessageOf(regenError, t));
					console.error('[editing-message] regenerate failed; the source session is unchanged.', regenError);
				});
			};
			const referenceLabels = Array.isArray(data.referenceLabels) ? data.referenceLabels : [];
			return h('div', { className: 'dsem-row' },
				editing === true
					? h(EditorCard, {
						t,
						initial: drafts.has(draftKey) ? drafts.get(draftKey) : text,
						onDraftChange: changeDraft,
						onCancel: cancelEdit,
						onSubmit: submitEdit,
					})
					: h('div', { className: 'dsem-stack' },
						h(AttachmentRow, { parts, renderMessageImages: props.renderMessageImages }),
						text !== '' || parts.rest.length > 0
							? h('div', { className: 'dsem-bubble' }, text)
							: null,
						parts.rest.length > 0 ? h(RestBlocks, { rest: parts.rest }) : null,
						referenceLabels.length > 0
							? h('div', { className: 'dsem-referenceSummary' },
								t('references', { labels: referenceLabels.join(', ') }))
							: null),
				editing === true
					? null
					: h(MessageActionsRow, {
						t,
						text,
						time: typeof data.time === 'number' ? data.time : undefined,
						atSeq,
						busy: busy === true || editAvailable === false,
						onEdit: beginEdit,
						onRegen: regenerate,
					}),
				editing === false && error !== null
					? h('span', { className: 'dsem-error', role: 'status' }, error)
					: null);
		}

		/** Slot entry: boundary-wrapped view with a plain fallback bubble. */
		function EditingMessageEntry(props) {
			const fallback = PlainBubble({ data: props.node && props.node.data });
			return h(SafeBoundary, { fallback }, h(EditingMessageView, props));
		}
		//#endregion

		//#region apply
		/**
		 * Read one client service without dying: the documented ctx.get(name)
		 * first, then a direct property fallback for older context shapes.
		 * undefined/null means "not available" — callers degrade gracefully.
		 */
		function readService(ctx, key) {
			try {
				if (typeof ctx.get === 'function') {
					const value = ctx.get(key);
					if (value !== undefined && value !== null) return value;
				}
			} catch {
				// Fall through to the property form.
			}
			try {
				const value = ctx[key];
				return value === undefined ? null : value;
			} catch {
				return null;
			}
		}

		function applyPlugin(ctx) {
			// Keep the activation context for lazy service resolution: module
			// load order is not guaranteed (our bundle may sit BEFORE the
			// sessions controller in the combo), so a service read at apply
			// time can legitimately miss. Registration must not depend on it —
			// sessions/uiWorkspace resolve on first use instead.
			rootCtx = ctx;

			injectStyles();

			try {
				const locale = readService(ctx, 'locale');
				if (locale && typeof locale.register === 'function') {
					locale.register(NS, { en, ru });
				}
			} catch (error) {
				// No locale service: the components fall back to the local dictionary.
				console.error('[editing-message] locale registration failed; local copy is used.', error);
			}

			// Each slot registration is contained: one failure must cost the
			// plugin its buttons, never the whole client entry (whose rejection
			// the web shell treats as fatal).
			const slots = readService(ctx, 'slots');
			if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
				console.error('[editing-message] slots service is unavailable; the plugin stays inert.');
				return;
			}
			const safeInject = (slot, maker) => {
				try {
					slots.inject(slot, () => {
						try {
							return maker();
						} catch (error) {
							console.error('[editing-message] slot registration failed (' + slot + '); it stays off.', error);
							return undefined;
						}
					});
				} catch (error) {
					console.error('[editing-message] slot inject failed (' + slot + '); it stays off.', error);
				}
			};
			// Shadowing registration for keyed cells: the shipped renderers sit at
			// priority 0, and a second registration at the SAME priority throws
			// ("already has an entry for key"). The cell's LOWEST live priority
			// renders, so we take -1 and fall back to -2, -3… if a rival plugin
			// ever occupies that rank too. When this plugin unloads, its entry
			// retires and the shipped renderer takes the cell back.
			const shadowingRegister = (slotOptions, component) => {
				const priorities = [-1, -2, -3, -4, -5, -6];
				let lastError = null;
				for (const priority of priorities) {
					try {
						const dispose = slots.register({ ...slotOptions, priority }, component);
						console.error('[editing-message] renderer installed for key "' + slotOptions.key + '" at priority ' + priority + '.');
						return dispose;
					} catch (error) {
						lastError = error;
					}
				}
				throw lastError;
			};
			// Shadowing the shipped keys: our row keeps the same visual language
			// and adds the two buttons next to copy; disabling the plugin
			// restores the shipped renderers automatically. NOT gated on the
			// sessions service: load order is not guaranteed, and the verbs are
			// only needed at click time.
			safeInject('conversation.chat.node', () => shadowingRegister({
				name: 'conversation.chat.node', key: 'user', locale: NS,
			}, EditingMessageEntry));
			safeInject('conversation.chat.node', () => shadowingRegister({
				name: 'conversation.chat.node', key: 'steering', locale: NS,
			}, EditingMessageEntry));
		}

		/**
		 * Fail-safe wrapper: a broken plugin must never fail the client module
		 * entry — the web shell treats a rejected activation as fatal and would
		 * not mount the application at all. The plugin simply stays off.
		 */
		function apply(ctx) {
			try {
				return applyPlugin(ctx);
			} catch (error) {
				console.error('[editing-message] client startup failed; the plugin stays off.', error);
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	},
});
// dsh-editing-message 1.0.5 (rc.2: lazy service resolution, same-chat continue via fork+archive, chat-background photo inheritance, priority-shadowed renderer)
