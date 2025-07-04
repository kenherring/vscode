/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IBufferRange, Terminal as RawXtermTerminal } from '@xterm/xterm';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IDetachedTerminalInstance, ITerminalConfigurationService, ITerminalContribution, ITerminalInstance, type IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type IDetachedCompatibleTerminalContributionContext, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { shouldPasteTerminalText } from './terminalClipboard.js';
import { Emitter } from '../../../../../base/common/event.js';
import { BrowserFeatures } from '../../../../../base/browser/canIUse.js';
import { TerminalCapability, type ITerminalCommand } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ITerminalLogService, TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';
import { isLinux, isMacintosh } from '../../../../../base/common/platform.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { registerActiveInstanceAction, registerActiveXtermAction } from '../../../terminal/browser/terminalActions.js';
import { TerminalCommandId } from '../../../terminal/common/terminal.js';
import { localize2 } from '../../../../../nls.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { terminalStrings } from '../../../terminal/common/terminalStrings.js';
import { isString } from '../../../../../base/common/types.js';

// #region Terminal Contributions

let logService: ITerminalLogService | undefined = undefined;

export class TerminalClipboardContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.clipboard';

	static get(instance: ITerminalInstance | IDetachedTerminalInstance): TerminalClipboardContribution | null {
		return instance.getContribution<TerminalClipboardContribution>(TerminalClipboardContribution.ID);
	}

	private _xterm: IXtermTerminal & { raw: RawXtermTerminal } | undefined;

	private _overrideCopySelection: boolean | undefined = undefined;
	// private _overrideCopyOnSelectionDisposable: IDisposable | undefined = undefined;

	private readonly _onWillPaste = this._register(new Emitter<string>());
	readonly onWillPaste = this._onWillPaste.event;
	private readonly _onDidPaste = this._register(new Emitter<string>());
	readonly onDidPaste = this._onDidPaste.event;

	private _previousSelection: string | undefined = undefined;
	private _previousSelectionPosition: IBufferRange | undefined = undefined;

	// protected readonly _logService: ITerminalLogService

	constructor(
		private readonly _ctx: ITerminalContributionContext | IDetachedCompatibleTerminalContributionContext,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ITerminalLogService private readonly _logService: ITerminalLogService,
		@ITerminalConfigurationService private readonly _terminalConfigurationService: ITerminalConfigurationService,
	) {
		super();
		logService = _logService;
		// this._logService = _ctx.instance.capabilities.get(TerminalCapability.LogService) ?? _instantiationService.createInstance(ITerminalLogService);
	}

	notify(event: string) {
		this._logService.info('[clipboard] ' + event);
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this.notify('xtermReady');
		this._xterm = xterm;
		// TODO: This should be a different event on xterm, copying html should not share the requesting run command event
		this._register(xterm.onDidRequestCopyAsHtml(e => {
			this.notify('onDidRequestCopyAsHtml');
			return this.copySelection(true, e.command);
		}));
		this._register(xterm.raw.onWriteParsed(async (e) => {
			this.notify('onWriteParsed');
		}));
		this._register(xterm.raw.onData(async (e) => {
			this.notify('onData');
		}));
		this._register(xterm.raw.onRender(async (e) => {
			this.notify('onRender e=' + JSON.stringify(e) + ', hasSelection=' + xterm.raw.hasSelection() + ', selection=' + xterm.raw.getSelection());
		}));
		this._register(xterm.raw.onBinary(async (e) => {
			this.notify('onBinary');
		}));
		this._register(xterm.raw.onBell(async () => {
			this.notify('onBell');
		}));
		this._register(xterm.raw.onCursorMove(async () => {
			this.notify('onCursorMove');
		}));
		this._register(xterm.raw.onKey(async (e) => {
			this.notify('onKey key=' + e.key);
		}));
		this._register(xterm.raw.onLineFeed(async () => {
			this.notify('onLineFeed');
		}));
		this._register(xterm.raw.onResize(async () => {
			this.notify('onResize');
		}));
		this._register(xterm.raw.onScroll(async () => {
			this.notify('onScroll');
		}));
		this._register(xterm.raw.onTitleChange(async () => {
			this.notify('onTitleChange');
		}));

		// this._register(dom.addDisposableListener(xterm.raw.element, 'keydown', (e: MouseEvent) => {
		// 	this._logService.info('[terminalInstance] keydown.1');
		// 	this._isKeydown = true;
		// 	const listener = dom.addDisposableListener(xterm.raw.element!.ownerDocument, 'keyup', () => {

		// 		this._logService.info('[terminalInstance] keydown.2 (keyup)');
		// 		this._isKeydown = false;
		// 		// Delay with a setTimeout to allow the mouseup to propagate through the DOM
		// 		// before evaluating the new selection state.

		// 		listener.dispose();
		// 	});

		// }));

		// this._register(xterm.raw.onSelectionChange(async () => {
		this._register(xterm.onDidChangeSelection(async () => {
			this.notify('copySelection.1');
			if (this._configurationService.getValue(TerminalSettingId.CopyOnSelection)) {
				// this._notificationService.info('copySelection.1 triggered by selection change override=' + this._overrideCopySelection + ', hasSelection=' + this._ctx.instance.hasSelection());
				this.notify('copySelection.2 triggered by selection change override=' + this._overrideCopySelection + ', hasSelection=' + this._ctx.instance.hasSelection());
				if (this._overrideCopySelection === false) {
					this.notify('copySelection.3 - copy on selection override is false, not copying');
					// this._overrideCopyOnSelectionDisposable?.dispose();
					return;
				}
				this.notify('      _previousSelection=' + this._previousSelection);
				this.notify('xterm.raw.getSelection()=' + xterm.raw.getSelection());
				this.notify('      _previousSelectionPosition=' + JSON.stringify(this._previousSelectionPosition));
				this.notify('xterm.raw.getSelectionPosition()=' + JSON.stringify(xterm.raw.getSelectionPosition()));
				if (xterm.raw.getSelection() === this._previousSelection
					&& JSON.stringify(xterm.raw.getSelectionPosition()) === JSON.stringify(this._previousSelectionPosition)) {
					this.notify('copySelection.4 - return as selection has not changed');
					return;
				}
				if (this._ctx.instance.hasSelection()) {
					this.notify('copySelection.5 - copying selection');
					this._previousSelection = xterm.raw.getSelection();
					this._previousSelectionPosition = xterm.raw.getSelectionPosition();
					await this.copySelection();
				}
			}
		}));
		// this._register(xterm.onDidChangeFindResults(() => {
		// 	this._overrideCopyOnSelectionDisposable?.dispose();
		// }));
	}

	async copySelection(asHtml?: boolean, command?: ITerminalCommand): Promise<void> {
		this.notify('copySelection-1');
		// TODO: Confirm this is fine that it's no longer awaiting xterm promise

		// this._notificationService.info('Copying selection to clipboard? override=' + this._overrideCopySelection);
		// if (this._overrideCopySelection === false) {
		// 	this._notificationService.info('Copy on selection override is false, not copying');
		// 	return;
		// }

		this._xterm?.copySelection(asHtml, command);
		this.notify('copySelection-2 new selection=' + this._ctx?.instance.selection);
	}

	/**
	 * Focuses and pastes the contents of the clipboard into the terminal instance.
	 */
	async paste(): Promise<void> {
		this.notify('paste-1');
		// this._overrideCopyOnSelectionDisposable =
		// this.overrideCopyOnSelection(false);
		this.notify('paste-2');
		await this._paste(await this._clipboardService.readText());
		this.notify('paste-3');
		// .then(() => {
		// 	this._overrideCopyOnSelectionDisposable?.dispose();
		// });
	}

	/**
	 * Focuses and pastes the contents of the selection clipboard into the terminal instance.
	 */
	async pasteSelection(): Promise<void> {
		this.notify('pasteSelection-1');
		// this._overrideCopyOnSelectionDisposable = this.overrideCopyOnSelection(false);
		this.overrideCopyOnSelection(false);
		await this._paste(await this._clipboardService.readText('selection'));
		// .then(() => {
		// 	this._overrideCopyOnSelectionDisposable?.dispose();
		// });
	}

	private async _paste(value: string): Promise<void> {
		this.notify('_paste-1');
		if (!this._xterm) {
			this.notify('_paste-1 - missing xterm');
			return;
		}

		let currentText = value;
		const shouldPasteText = await this._instantiationService.invokeFunction(shouldPasteTerminalText, currentText, this._xterm?.raw.modes.bracketedPasteMode);
		if (!shouldPasteText) {
			return;
		}

		this.notify('paste-3');

		if (typeof shouldPasteText === 'object') {
			currentText = shouldPasteText.modifiedText;
		}

		this._ctx.instance.focus();

		this._onWillPaste.fire(currentText);
		this.notify('paste-4 currentText=' + currentText);
		this._xterm.raw.paste(currentText);
		this._onDidPaste.fire(currentText);
	}

	async handleMouseEvent(event: MouseEvent): Promise<{ handled: boolean } | void> {
		switch (event.button) {
			case 1: { // Middle click
				if (this._terminalConfigurationService.config.middleClickBehavior === 'paste') {
					this.paste();
					return { handled: true };
				}
				break;
			}
			case 2: { // Right click
				// Ignore shift click as it forces the context menu
				if (event.shiftKey) {
					return;
				}
				const rightClickBehavior = this._terminalConfigurationService.config.rightClickBehavior;
				if (rightClickBehavior !== 'copyPaste' && rightClickBehavior !== 'paste') {
					return;
				}
				if (rightClickBehavior === 'copyPaste' && this._ctx.instance.hasSelection()) {
					await this.copySelection();
					this._ctx.instance.clearSelection();
				} else {
					if (BrowserFeatures.clipboard.readText) {
						this.paste();
					} else {
						this._notificationService.info(`This browser doesn't support the clipboard.readText API needed to trigger a paste, try ${isMacintosh ? '⌘' : 'Ctrl'}+V instead.`);
					}
				}
				// Clear selection after all click event bubbling is finished on Mac to prevent
				// right-click selecting a word which is seemed cannot be disabled. There is a
				// flicker when pasting but this appears to give the best experience if the
				// setting is enabled.
				if (isMacintosh) {
					setTimeout(() => this._ctx.instance.clearSelection(), 0);
				}
				return { handled: true };
			}
		}
	}

	/**
	 * Override the copy on selection feature with a custom value.
	 * @param value Whether to enable copySelection.
	 */
	overrideCopyOnSelection(value: boolean): IDisposable {
		this.notify('overrideCopyOnSelection=' + value);
		if (this._overrideCopySelection !== undefined) {
			this.notify('Cannot set a copy on selection override multiple times');
			throw new Error('Cannot set a copy on selection override multiple times');
		}
		this._overrideCopySelection = value;
		this.notify('this._overrideCopySelection=' + this._overrideCopySelection);
		return toDisposable(() => {
			this.notify('Clearing overrideCopyOnSelection');
			this._overrideCopySelection = undefined;
		});
	}
}

registerTerminalContribution(TerminalClipboardContribution.ID, TerminalClipboardContribution, false);

// #endregion

// #region Actions

const terminalAvailableWhenClause = ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.terminalHasBeenCreated);

// TODO: Move these commands into this terminalContrib/
registerActiveInstanceAction({
	id: TerminalCommandId.CopyLastCommand,
	title: localize2('workbench.action.terminal.copyLastCommand', "Copy Last Command"),
	precondition: terminalAvailableWhenClause,
	run: async (instance, c, accessor) => {
		logService?.info('[clipboard] workbench.action.terminal.copyLastCommand');
		const clipboardService = accessor.get(IClipboardService);
		const commands = instance.capabilities.get(TerminalCapability.CommandDetection)?.commands;
		if (!commands || commands.length === 0) {
			return;
		}
		const command = commands[commands.length - 1];
		if (!command.command) {
			return;
		}
		await clipboardService.writeText(command.command);
	}
});

registerActiveInstanceAction({
	id: TerminalCommandId.CopyLastCommandOutput,
	title: localize2('workbench.action.terminal.copyLastCommandOutput', "Copy Last Command Output"),
	precondition: terminalAvailableWhenClause,
	run: async (instance, c, accessor) => {
		logService?.info('[clipboard] workbench.action.terminal.copyLastCommandOutput');
		const clipboardService = accessor.get(IClipboardService);
		const commands = instance.capabilities.get(TerminalCapability.CommandDetection)?.commands;
		if (!commands || commands.length === 0) {
			return;
		}
		const command = commands[commands.length - 1];
		if (!command?.hasOutput()) {
			return;
		}
		const output = command.getOutput();
		if (isString(output)) {
			await clipboardService.writeText(output);
		}
	}
});

registerActiveInstanceAction({
	id: TerminalCommandId.CopyLastCommandAndLastCommandOutput,
	title: localize2('workbench.action.terminal.copyLastCommandAndOutput', "Copy Last Command and Output"),
	precondition: terminalAvailableWhenClause,
	run: async (instance, c, accessor) => {
		logService?.info('[clipboard] workbench.action.terminal.copyLastCommandAndOutput');
		const clipboardService = accessor.get(IClipboardService);
		const commands = instance.capabilities.get(TerminalCapability.CommandDetection)?.commands;
		if (!commands || commands.length === 0) {
			return;
		}
		const command = commands[commands.length - 1];
		if (!command?.hasOutput()) {
			return;
		}
		const output = command.getOutput();
		if (isString(output)) {
			await clipboardService.writeText(`${command.command !== '' ? command.command + '\n' : ''}${output}`);
		}
	}
});

// Some commands depend on platform features
if (BrowserFeatures.clipboard.writeText) {
	registerActiveXtermAction({
		id: TerminalCommandId.CopySelection,
		title: localize2('workbench.action.terminal.copySelection', 'Copy Selection'),
		// TODO: Why is copy still showing up when text isn't selected?
		precondition: ContextKeyExpr.or(TerminalContextKeys.textSelectedInFocused, ContextKeyExpr.and(terminalAvailableWhenClause, TerminalContextKeys.textSelected)),
		keybinding: [{
			primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyC,
			mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyC },
			weight: KeybindingWeight.WorkbenchContrib,
			when: ContextKeyExpr.or(
				ContextKeyExpr.and(TerminalContextKeys.textSelected, TerminalContextKeys.focus),
				TerminalContextKeys.textSelectedInFocused,
			)
		}],
		run: (activeInstance) => {
			logService?.info('[clipboard] workbench.action.terminal.copySelection');
			return activeInstance.copySelection();
		}
	});

	registerActiveXtermAction({
		id: TerminalCommandId.CopyAndClearSelection,
		title: localize2('workbench.action.terminal.copyAndClearSelection', 'Copy and Clear Selection'),
		precondition: ContextKeyExpr.or(TerminalContextKeys.textSelectedInFocused, ContextKeyExpr.and(terminalAvailableWhenClause, TerminalContextKeys.textSelected)),
		keybinding: [{
			win: { primary: KeyMod.CtrlCmd | KeyCode.KeyC },
			weight: KeybindingWeight.WorkbenchContrib,
			when: ContextKeyExpr.or(
				ContextKeyExpr.and(TerminalContextKeys.textSelected, TerminalContextKeys.focus),
				TerminalContextKeys.textSelectedInFocused,
			)
		}],
		run: async (xterm) => {
			logService?.info('[clipboard] workbench.action.terminal.copyAndClearSelection');
			await xterm.copySelection();
			xterm.clearSelection();
		}
	});

	registerActiveXtermAction({
		id: TerminalCommandId.CopySelectionAsHtml,
		title: localize2('workbench.action.terminal.copySelectionAsHtml', 'Copy Selection as HTML'),
		f1: true,
		category: terminalStrings.actionCategory,
		precondition: ContextKeyExpr.or(TerminalContextKeys.textSelectedInFocused, ContextKeyExpr.and(terminalAvailableWhenClause, TerminalContextKeys.textSelected)),
		run: (xterm) => {
			logService?.info('[clipboard] workbench.action.terminal.copySelectionAsHtml');
			return xterm.copySelection(true);
		}
	});
}

if (BrowserFeatures.clipboard.readText) {
	registerActiveInstanceAction({
		id: TerminalCommandId.Paste,
		title: localize2('workbench.action.terminal.paste', 'Paste into Active Terminal'),
		precondition: terminalAvailableWhenClause,
		keybinding: [{
			primary: KeyMod.CtrlCmd | KeyCode.KeyV,
			win: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV] },
			linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV },
			weight: KeybindingWeight.WorkbenchContrib,
			when: TerminalContextKeys.focus
		}],
		run: (activeInstance) => {
			// const overrideCopyOnSelectionDisposable = TerminalClipboardContribution.get(activeInstance)?.overrideCopyOnSelection(false);
			// TerminalClipboardContribution.get(activeInstance)?.overrideCopyOnSelection(false);
			logService?.info('[clipboard] workbench.action.terminal.paste');
			return TerminalClipboardContribution.get(activeInstance)?.paste();
			// .then(() => {
			// 	overrideCopyOnSelectionDisposable?.dispose();
			// });
		}
	});
}

if (BrowserFeatures.clipboard.readText && isLinux) {
	registerActiveInstanceAction({
		id: TerminalCommandId.PasteSelection,
		title: localize2('workbench.action.terminal.pasteSelection', 'Paste Selection into Active Terminal'),
		precondition: terminalAvailableWhenClause,
		keybinding: [{
			linux: { primary: KeyMod.Shift | KeyCode.Insert },
			weight: KeybindingWeight.WorkbenchContrib,
			when: TerminalContextKeys.focus
		}],
		run: (activeInstance) => {
			logService?.info('[clipboard] workbench.action.terminal.pasteSelection');
			TerminalClipboardContribution.get(activeInstance)?.notify('paste-4');
			return TerminalClipboardContribution.get(activeInstance)?.pasteSelection();
		}
	});
}

// #endregion
