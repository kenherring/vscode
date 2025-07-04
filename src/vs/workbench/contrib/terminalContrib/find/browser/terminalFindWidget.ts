/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { SimpleFindWidget } from '../../../codeEditor/browser/find/simpleFindWidget.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService, IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDetachedTerminalInstance, ITerminalInstance, IXtermTerminal, XtermTerminalConstants } from '../../../terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { Event } from '../../../../../base/common/event.js';
import type { ISearchOptions } from '@xterm/addon-search';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { TerminalFindCommandId } from '../common/terminal.find.js';
import { TerminalClipboardContribution } from '../../clipboard/browser/terminal.clipboard.contribution.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { createTextInputActions } from '../../../../browser/actions/textInputActions.js';
import { ITerminalLogService } from '../../../../../platform/terminal/common/terminal.js';

const TERMINAL_FIND_WIDGET_INITIAL_WIDTH = 419;

export class TerminalFindWidget extends SimpleFindWidget {
	private _findInputFocused: IContextKey<boolean>;
	private _findWidgetFocused: IContextKey<boolean>;
	private _findWidgetVisible: IContextKey<boolean>;

	private _overrideCopyOnSelectionDisposable: IDisposable | undefined;

	constructor(
		private _instance: ITerminalInstance | IDetachedTerminalInstance,
		@IClipboardService clipboardService: IClipboardService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService hoverService: IHoverService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IThemeService themeService: IThemeService,
		@ITerminalLogService private readonly _logService: ITerminalLogService,
	) {
		super({
			showCommonFindToggles: true,
			checkImeCompletionState: true,
			showResultCount: true,
			initialWidth: TERMINAL_FIND_WIDGET_INITIAL_WIDTH,
			enableSash: true,
			appendCaseSensitiveActionId: TerminalFindCommandId.ToggleFindCaseSensitive,
			appendRegexActionId: TerminalFindCommandId.ToggleFindRegex,
			appendWholeWordsActionId: TerminalFindCommandId.ToggleFindWholeWord,
			previousMatchActionId: TerminalFindCommandId.FindPrevious,
			nextMatchActionId: TerminalFindCommandId.FindNext,
			closeWidgetActionId: TerminalFindCommandId.FindHide,
			type: 'Terminal',
			matchesLimit: XtermTerminalConstants.SearchHighlightLimit
		}, contextViewService, contextKeyService, hoverService, keybindingService);

		this._register(this.state.onFindReplaceStateChange(() => {
			this.notify('onFindReplaceStateChange-1');
			this.show();
		}));
		this._findInputFocused = TerminalContextKeys.findInputFocus.bindTo(contextKeyService);
		this._findWidgetFocused = TerminalContextKeys.findFocus.bindTo(contextKeyService);
		this._findWidgetVisible = TerminalContextKeys.findVisible.bindTo(contextKeyService);
		const innerDom = this.getDomNode().firstChild;
		if (innerDom) {
			this._register(dom.addDisposableListener(innerDom, 'mousedown', (event) => {
				this.notify('mousedown-1');
				event.stopPropagation();
			}));
			this._register(dom.addDisposableListener(innerDom, 'contextmenu', (event) => {
				this.notify('contextmenu-1');
				event.stopPropagation();
			}));
		}
		const findInputDomNode = this.getFindInputDomNode();
		this._register(dom.addDisposableListener(findInputDomNode, 'contextmenu', (event) => {
			this.notify('contextmenu-2');
			const targetWindow = dom.getWindow(findInputDomNode);
			const standardEvent = new StandardMouseEvent(targetWindow, event);
			const actions = createTextInputActions(clipboardService);

			contextMenuService.showContextMenu({
				getAnchor: () => standardEvent,
				getActions: () => actions,
				getActionsContext: () => event.target,
			});
			event.stopPropagation();
		}));
		this._register(themeService.onDidColorThemeChange(() => {
			this.notify('onDidColorThemeChange-1');
			if (this.isVisible()) {
				this.find(true, true);
			}
		}));
		this._register(configurationService.onDidChangeConfiguration((e) => {
			this.notify('onDidChangeConfiguration-1');
			if (e.affectsConfiguration('workbench.colorCustomizations') && this.isVisible()) {
				this.find(true, true);
			}
		}));

		const instance = TerminalClipboardContribution.get(this._instance);
		if (instance) {
			this._register(instance.onWillPaste(() => {
				instance.notify('onWillPaste-1');
				this._overrideCopyOnSelectionDisposable = TerminalClipboardContribution.get(this._instance)?.overrideCopyOnSelection(false);
			}));
		}


		this.updateResultCount();
	}

	notify(event: string) {
		this._logService.info('[FindWidget] ' + event);
	}


	find(previous: boolean, update?: boolean) {
		this.notify('find-1');
		const xterm = this._instance.xterm;
		if (!xterm) {
			return;
		}
		if (previous) {
			this._findPreviousWithEvent(xterm, this.inputValue, { regex: this._getRegexValue(), wholeWord: this._getWholeWordValue(), caseSensitive: this._getCaseSensitiveValue(), incremental: update });
		} else {
			this._findNextWithEvent(xterm, this.inputValue, { regex: this._getRegexValue(), wholeWord: this._getWholeWordValue(), caseSensitive: this._getCaseSensitiveValue() });
		}
	}

	override reveal(): void {
		this.notify('reveal-1');
		const initialInput = this._instance.hasSelection() && !this._instance.selection!.includes('\n') ? this._instance.selection : undefined;
		const inputValue = initialInput ?? this.inputValue;
		const xterm = this._instance.xterm;
		if (xterm && inputValue && inputValue !== '') {
			// trigger highlight all matches
			this._findPreviousWithEvent(xterm, inputValue, { incremental: true, regex: this._getRegexValue(), wholeWord: this._getWholeWordValue(), caseSensitive: this._getCaseSensitiveValue() }).then(foundMatch => {
				this.updateButtons(foundMatch);
				this._register(Event.once(xterm.onDidChangeSelection)(() => xterm.clearActiveSearchDecoration()));
			});
		}
		this.updateButtons(false);

		super.reveal(inputValue);
		this._findWidgetVisible.set(true);
	}

	override show() {
		this.notify('show-1');
		const initialInput = this._instance.hasSelection() && !this._instance.selection!.includes('\n') ? this._instance.selection : undefined;
		super.show(initialInput);
		this._findWidgetVisible.set(true);
	}

	override hide() {
		this.notify('hide-1');
		super.hide();
		this._findWidgetVisible.reset();
		this._instance.focus(true);
		this._instance.xterm?.clearSearchDecorations();
	}

	protected async _getResultCount(): Promise<{ resultIndex: number; resultCount: number } | undefined> {
		this.notify('_getResultCount-1');
		return this._instance.xterm?.findResult;
	}

	protected _onInputChanged() {
		this.notify('_onInputChanged-1');
		// Ignore input changes for now
		const xterm = this._instance.xterm;
		if (xterm) {
			this.notify('_onInputChanged-2');
			this._overrideCopyOnSelectionDisposable?.dispose();
			this._findPreviousWithEvent(xterm, this.inputValue, { regex: this._getRegexValue(), wholeWord: this._getWholeWordValue(), caseSensitive: this._getCaseSensitiveValue(), incremental: true }).then(foundMatch => {
				this.updateButtons(foundMatch);
			});
		}
		return false;
	}

	protected _onFocusTrackerFocus() {
		this.notify('_onFocusTrackerFocus-1');
		if (TerminalClipboardContribution.get(this._instance)?.overrideCopyOnSelection) {
			this.notify('_onFocusTrackerFocus-2');
			this._overrideCopyOnSelectionDisposable = TerminalClipboardContribution.get(this._instance)?.overrideCopyOnSelection(false);
		}
		this._findWidgetFocused.set(true);
	}

	protected _onFocusTrackerBlur() {
		this.notify('_onFocusTrackerBlur-1');
		TerminalClipboardContribution.get(this._instance)?.notify('_onFocusTrackerBlur-1');
		// this._overrideCopyOnSelectionDisposable?.dispose();
		this._instance.xterm?.clearActiveSearchDecoration();
		this._findWidgetFocused.reset();
	}

	protected _onFindInputFocusTrackerFocus() {
		this.notify('_onFindInputFocusTrackerFocus-1');
		this._findInputFocused.set(true);
	}

	protected _onFindInputFocusTrackerBlur() {
		this.notify('_onFindInputFocusTrackerBlur-1');
		this._findInputFocused.reset();
	}

	findFirst() {
		this.notify('findFirst-1');
		const instance = this._instance;
		if (instance.hasSelection()) {
			instance.clearSelection();
		}
		const xterm = instance.xterm;
		if (xterm) {
			this._findPreviousWithEvent(xterm, this.inputValue, { regex: this._getRegexValue(), wholeWord: this._getWholeWordValue(), caseSensitive: this._getCaseSensitiveValue() });
		}
	}

	private async _findNextWithEvent(xterm: IXtermTerminal, term: string, options: ISearchOptions): Promise<boolean> {
		this.notify('_findNextWithEvent-1');
		return xterm.findNext(term, options).then(foundMatch => {
			this.notify('_findNextWithEvent-2.next');
			this._register(Event.once(xterm.onDidChangeSelection)(() => {
				this.notify('_findNextWithEvent-2.onDidChangeSelection');
				return xterm.clearActiveSearchDecoration();
			}));
			return foundMatch;
		});
	}

	private async _findPreviousWithEvent(xterm: IXtermTerminal, term: string, options: ISearchOptions): Promise<boolean> {
		this.notify('_findPreviousWithEvent-1');
		return xterm.findPrevious(term, options).then(foundMatch => {
			this.notify('_findPreviousWithEvent-2');
			this._register(Event.once(xterm.onDidChangeSelection)(() => {
				this.notify('_findPreviousWithEvent-3');
				return xterm.clearActiveSearchDecoration()
			}));
			return foundMatch;
		});
	}
}
