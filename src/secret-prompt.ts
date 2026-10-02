import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { type FormFieldTheme, TextFormField } from "@oh-my-pi/pi-tui";

/**
 * Masked single-field prompt: the typed value is rendered as bullets and never echoed.
 *
 * Only the root `@oh-my-pi/pi-tui` export is used and styling comes from the host's `theme`
 * argument: the extension loads its own copy of pi-tui, whose global theme/chrome singletons
 * are never initialised (importing `chrome/*` fails with `undefined is not an object (theme.fg)`).
 */
export function createSecretPrompt(
	theme: Theme,
	title: string,
	description: string | undefined,
	onSubmit: (value: string) => void,
	onCancel: () => void,
): TextFormField {
	const formTheme: FormFieldTheme = {
		label: text => theme.bold(theme.fg("accent", text)),
		description: text => theme.fg("muted", text),
		error: text => theme.fg("error", text),
		hint: text => theme.fg("dim", text),
	};
	return new TextFormField({
		theme: formTheme,
		label: title,
		description,
		secret: true,
		empty: "reject",
		emptyError: "A secret is required.",
		hint: "Enter submit  Esc cancel",
		leadingSpace: true,
		onSubmit,
		onCancel,
	});
}
