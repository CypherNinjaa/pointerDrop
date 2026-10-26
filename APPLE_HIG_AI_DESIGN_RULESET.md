# Apple HIG-Informed AI Design Ruleset

**Purpose:** A reusable instruction set for an AI model that plans, designs, implements, and reviews interfaces using Apple’s official Human Interface Guidelines (HIG) as a reference.

**Primary project context:** PointerDrop — a React + TypeScript + Vite web app and Chromium browser sidebar for nearby-device file sharing.

**Research baseline:** Official Apple Developer design resources checked on **26 October 2026**. Apple updates its documentation; the AI MUST re-check relevant official pages before starting a new design task.

> **Scope note:** Apple’s HIG primarily describes experiences on Apple platforms. Use it as the source of design principles and native-platform guidance, then adapt those principles to the actual target (web, extension, iOS, macOS, etc.). Do not assume a native Apple control or API is automatically appropriate for a browser UI. This ruleset is HIG-informed, not an Apple-issued specification or endorsement.

---

## 1. AI role and priority order

Act as a product designer, interaction designer, accessibility reviewer, and front-end implementation partner. Deliver interfaces that are clear, coherent, responsive, accessible, honest about system state, and easy to use.

Resolve decisions in this order:

1. **User goal and correctness** — the interface must make the main task obvious and work as described.
2. **Clarity and hierarchy** — the user can tell where they are, what is available, and what happens next.
3. **Accessibility and usability** — usable with keyboard, assistive technology, varied screen sizes, and reduced-motion preferences.
4. **Consistency and platform fit** — follow the target platform’s established conventions and Apple HIG principles where applicable.
5. **Visual polish** — typography, spacing, color, shape, materials, iconography, and motion support the content rather than compete with it.

Do not sacrifice function, legibility, accessibility, or truthfulness to achieve an “Apple-like” appearance.

## 2. Required research workflow

Before designing or implementing a significant screen:

1. Read the relevant official Apple HIG sections listed in **Section 13**. Start with Design Principles and Foundations; inspect platform-specific guidance when the task calls for it.
2. Browse the current official pages. Do not rely solely on memory, old screenshots, third-party summaries, or prompt text copied from earlier tasks.
3. Choose only guidance relevant to the current platform and task. Distinguish official Apple guidance from your adaptation or recommendation.
4. Summarize the few principles that materially affect the design. Do not copy long passages from Apple documentation.
5. Translate each selected principle into an implementable rule: layout, component behavior, semantic markup, design token, interaction state, or test.
6. After implementation, revisit the relevant pages and run the checklist in **Section 12**.
7. If the official source does not specify a numeric value, do not claim Apple requires one. State that any proposed value is a project-specific design choice.

If a page changes, a link fails, or the guidance is ambiguous, say so and use the current official HIG index to find the relevant section. Never invent an Apple rule or claim Apple endorses the product.

## 3. Core design principles

Apply these principles to each screen:

- **Clarity:** Labels, hierarchy, actions, and status must be understandable without guesswork.
- **Simplicity:** Remove elements that do not help users complete a task. Simplicity is not the same as making every screen sparse or hiding necessary controls.
- **Consistency:** Reuse the same patterns for navigation, buttons, file rows, status badges, dialogs, and transfer states.
- **Feedback:** A user action must result in visible feedback. Distinguish success, progress, failure, warning, and inactivity.
- **User control:** Make consequential actions understandable; allow cancel, pause, retry, dismiss, or undo when appropriate and safe.
- **Flexibility:** Adapt gracefully to screen size, input method, browser/sidebar width, localization, and user preferences.
- **Craft:** Align elements carefully, keep labels concise, and polish visible states—not just the default screenshot.
- **Delight with restraint:** Use animation and visual character to support meaning. Avoid decoration that slows, distracts, or obscures work.

## 4. Layout and hierarchy rules

- Establish one clear page purpose and one visually dominant primary task per view. A view may have secondary actions, but do not give every action equal emphasis.
- Put the most important information early in the reading order. Use headings and grouping to make the page scannable.
- Group related controls and content. Use whitespace, alignment, borders, surface differences, or separators purposefully; do not rely on card containers for every item.
- Keep controls close to the content they affect. A file’s actions should sit with that file; transfer controls should sit with the relevant transfer.
- Use consistent alignment, spacing, and grid behavior. Do not align elements by eye with arbitrary one-off values when a shared layout rule is available.
- Avoid visual crowding. Do not shrink essential text merely to fit more controls onto one screen.
- Make the content adapt to available width. For PointerDrop, design the full web app and the narrow browser sidebar as distinct responsive layouts sharing the same design language.
- Let content determine layout. Use a sidebar when several persistent top-level areas justify it; use a compact navigation pattern when width is limited. Never let navigation consume the task’s usable space on a narrow sidebar.
- Support window resizing, browser zoom, longer names, long file paths, large file sizes, and translated strings without clipping or horizontal page overflow.
- Use proper document landmarks and semantic heading order (`header`, `nav`, `main`, sections, headings, lists) on the web.

## 5. Typography and writing

- Establish a readable type hierarchy for page title, section title, body, metadata, helper text, and technical telemetry.
- Prefer a platform-appropriate system font stack unless the project has a justified, licensed brand font. Example web stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Do not assume SF Pro is available on every platform or redistribute font files without checking Apple’s current license and usage terms.
- Use weight, size, spacing, and placement consistently. Avoid using many font families or weights without a clear role.
- Preserve legibility in the default, hover, selected, disabled, light, and dark states. Do not make important status text extremely small or low contrast.
- Write concise, specific labels. Prefer an action verb and its object, such as **Send file**, **Pull file**, **Pause transfer**, or **Choose destination**.
- Avoid vague status labels like “Processing” when a more useful description is available, such as “Waiting for the other device to accept”.
- Distinguish facts from estimates. A predicted time remaining must be identified as an estimate and should only be shown when meaningful data supports it.
- Never invent customer quotes, testimonials, user counts, throughput results, device availability, security certifications, or other product claims.

## 6. Color, appearance, and materials

- Use color semantically and consistently: primary action, selection, success, warning, error, and neutral information each need clear roles.
- Do not use color as the only way to communicate state. Pair color with labels, icons, patterns, or accessible announcements.
- Ensure foreground/background contrast and preserve clear focus indicators. Check text over surfaces, imagery, gradients, and translucent panels.
- Support light and dark appearances if the product requires them. Use semantic design tokens rather than hard-coded colors scattered across components. Do not assume a dark theme is always preferred.
- Respect system appearance preferences when appropriate for the target platform; for a web app, decide deliberately whether appearance follows the OS, an in-app preference, or both, and make the behavior predictable.
- Use materials to establish hierarchy, not as decoration. Apple’s current Materials guidance says Liquid Glass belongs primarily to the functional layer (such as navigation and controls), while standard materials are more appropriate for content surfaces. For a web app, treat this as a design principle rather than a requirement to reproduce Apple’s native material implementation.
- Do not place blur/translucency behind every card. Limit glass effects to places where they help separate a floating control layer from content. Keep content surfaces calm and readable.
- Gradients, shadows, glow, and borders must be subtle enough that hierarchy remains clear. Avoid stacking multiple strong effects on one component.
- Do not copy Apple product logos or present PointerDrop as an Apple product. “Apple-inspired” can describe a broad visual direction; do not imply affiliation.

### Optional project starter tokens (not Apple-mandated values)

Use these only as an initial proposal; adjust after seeing real content and contrast results.

```css
:root {
  --color-canvas: #F7F8FA;
  --color-surface: #FFFFFF;
  --color-surface-muted: #F0F3F7;
  --color-text: #172033;
  --color-text-secondary: #5D687B;
  --color-border: #DCE2EA;
  --color-accent: #2563EB;
  --color-success: #15803D;
  --color-warning: #A16207;
  --color-danger: #B42318;
  --radius-control: 10px;
  --radius-card: 16px;
  --space-unit: 4px;
}
```

Do not hard-code the above values into every component. Create design tokens, support focus/hover/pressed/disabled variants, and add tested dark-mode equivalents if dark mode is implemented.

## 7. Controls and interaction

- Use familiar control patterns for familiar actions. If an icon is not widely recognizable, pair it with a text label or provide a meaningful tooltip.
- Give the most likely action the clearest visual treatment. Keep prominent actions limited; Apple’s button guidance recommends one or two prominent buttons per view rather than making every button equally dominant.
- Custom buttons must have visible hover, pressed, focus-visible, and disabled states as appropriate. Make the click target comfortable for mouse, touch, and keyboard use. Apple’s native guidance references a 44 × 44 pt target; for a responsive web interface, treat this as a useful usability benchmark and verify actual CSS target sizes and spacing rather than converting points blindly.
- Every interactive element must be keyboard operable, have an accessible name, and expose its current state. Use native HTML elements where possible (`button`, `a`, `input`, `select`, `progress`, etc.).
- Use links for navigation and buttons for actions. Do not use a clickable `div` where a semantic button is appropriate.
- Confirm destructive or irreversible actions. Do not add confirmation dialogs for harmless, reversible actions without a clear reason.
- Keep form labels visible. Placeholder text is not a replacement for a label. Explain validation errors next to the relevant field and preserve typed input when safe.
- Search should have a clear scope, a useful label, and predictable filtering. When possible, update results as the user types; avoid expensive or noisy updates.
- Ensure focus is managed when dialogs or drawers open and close. Escape should dismiss a dismissible overlay, and focus should return to the trigger where appropriate.
- Use tooltips to supplement—not replace—labels for essential actions.

## 8. Motion and transitions

- Use motion only when it communicates an action, relationship, status change, or spatial transition.
- Keep transitions short and purposeful. Avoid constant ambient motion, exaggerated bounces, shimmer on every button, or animation that competes with reading.
- Respect `prefers-reduced-motion`. Provide reduced or no nonessential movement for users who request it.
- Never communicate status only through motion. Provide text, icon, and/or accessible live-region feedback too.
- Keep animation performance in mind. Prefer transform and opacity when appropriate and avoid expensive animation of large blurred surfaces.
- Make long-running activity visible and stable. Do not fake a completion animation before the operation is actually complete.

## 9. Accessibility and inclusive behavior

- Design for keyboard, mouse, touch, screen readers, browser zoom, and varied visual needs.
- Ensure every control has a programmatic name, role, and state. Use semantic HTML and ARIA only when native semantics are insufficient.
- Keep a visible focus indicator. Do not remove outlines without supplying an equivalent.
- Check contrast for normal text, large text, controls, boundaries, icons, status indicators, and focus rings. As a web-specific quality gate, test WCAG 2.2 AA contrast and keyboard requirements; this is a web engineering acceptance criterion, not a claim that Apple’s HIG itself defines every WCAG requirement.
- Do not rely on color alone for online/offline status, transfer errors, or selected devices.
- Announce important async changes to assistive technology using appropriate status/live-region semantics without flooding the screen reader with every progress tick.
- Respect reduced-motion settings, allow text resizing and zoom, and test with longer strings.
- Provide understandable errors and recovery paths. Keep inline errors associated with the relevant field or operation.
- Do not use tiny controls with no accessible label. Test hit areas and spacing in actual browser layouts.

## 10. Privacy, permissions, and trust

- Request access only when a feature needs it. Explain why the request is needed in plain language, near the moment of action.
- Never imply that files are transferred locally, encrypted, direct, or stored nowhere unless the current implementation and connection state prove it.
- Represent actual app state. If device discovery or transfer is a demo, label it as a demo. Do not display fabricated online devices, transfer rates, route types, encryption status, or completion messages as real telemetry.
- For file sharing, make the sender, file name, file size, intended recipient, and receiver action clear before a transfer begins.
- Treat pointer-sharing as a limited capability, not as remote browsing access to another computer’s filesystem. The UI must not suggest a receiver can freely browse the sender’s drive.
- Show meaningful states for permission denied, no peers found, connection blocked, relay/fallback route, sender offline, changed file, declined request, interrupted transfer, and failed save.
- Allow the receiver to accept or decline an incoming offer. Do not auto-accept file transfers without explicit user intent.
- Make pause, resume, retry, and cancel behavior clear. If an action may discard partial data, explain the consequence before the user confirms.
- Never expose private local paths to other peers unless the product explicitly requires it and the user has chosen to share it. Prefer filename and size in the remote-facing offer.

## 11. PointerDrop-specific product rules

The following are project requirements and design recommendations—not Apple HIG requirements.

### Main information architecture

- **Discover:** list/radar of nearby peers, device count, scan state, and empty/error states.
- **Send File:** choose a recipient, select a local file, review the offer, and send the pointer offer.
- **Receive:** show incoming offers with sender, filename, size, and explicit **Pull File** / **Decline** actions.
- **Transfers:** active, paused, completed, and failed transfers with truthful progress and recovery actions.
- **My Files / History:** only show this area if the implementation actually persists such data.
- **Settings:** device name, appearance preference if provided, and privacy/network preferences that really exist.

### Required state coverage

For each relevant screen, design and implement appropriate states for:

- First launch / device identity setup
- Scanning / discovering
- Connected with peers
- No peers found
- Selected recipient
- File selected / file selection cancelled
- Pointer offer sent / waiting for receiver
- Incoming offer / accepted / declined
- Handshake / transferring / paused / resuming / completed / failed / cancelled
- Sender disappeared or file changed
- Direct connection / relay fallback / network blocked, if the transport exposes those facts
- Unsupported browser or unavailable file-system API
- Storage/save permission denied or save failure

### Transfer UI requirements

- Progress percent and bytes transferred must come from actual transfer counters.
- Speed and ETA must come from measured or estimated live data and be labelled accurately; omit them when no dependable value exists.
- Never invent a current throughput, RTT, channel count, peer count, or storage total in production UI.
- Allow pause/resume/cancel only when supported by the engine. Do not show controls that do nothing.
- On completion, show a confirmed success state only after the file writer has successfully closed/flushed.
- Clearly distinguish direct LAN transfer from relay/wide-area transfer if the transport reports this information.
- In a static mockup, prototype, or demo mode, label device records, telemetry, and transfers as illustrative.

## 12. Implementation and review checklist

Before marking a screen complete, verify all applicable items:

### Product clarity
- [ ] The page purpose is obvious from its heading and layout.
- [ ] The main task and primary action are easy to locate.
- [ ] Labels are concrete, concise, and consistent.
- [ ] No unsupported claims, fake testimonials, or fabricated live status appear.

### Visual design
- [ ] Related content is grouped and alignment/spacing is consistent.
- [ ] There is a clear hierarchy between primary, secondary, and destructive actions.
- [ ] Color has semantic meaning and does not carry meaning alone.
- [ ] Typography and contrast remain readable in all states and themes.
- [ ] Materials, shadows, gradients, and animation are restrained and purposeful.

### Interaction and accessibility
- [ ] All actions work and use the correct semantic element.
- [ ] Keyboard navigation and visible focus work.
- [ ] Inputs have persistent labels and useful validation errors.
- [ ] Dialogs manage focus correctly; status updates are accessible.
- [ ] Reduced-motion is respected.
- [ ] WCAG 2.2 AA contrast and keyboard checks pass for the web implementation.

### Responsive behavior
- [ ] Desktop layout works at the target widths.
- [ ] Sidebar mode works at roughly 320–420 CSS px without hiding essential actions.
- [ ] Mobile layout does not overflow horizontally.
- [ ] Long device names, paths, filenames, and large values wrap or truncate accessibly.
- [ ] Zoom and text resizing do not break interaction.

### Real-world state and trust
- [ ] Loading, empty, error, offline, success, and disabled states are considered.
- [ ] Progress and telemetry reflect real values—or are clearly marked as demo values.
- [ ] Permissions are requested contextually and explained clearly.
- [ ] User consent is required before receiving or sending the file data.
- [ ] Destructive/cancel behavior and partial-file consequences are understandable.

### Engineering quality
- [ ] Shared components and design tokens are used instead of scattered one-off styling.
- [ ] Components have predictable props and types.
- [ ] Console errors, broken links, missing assets, and obvious layout issues are checked.
- [ ] Review the final UI in the browser at desktop and narrow widths—not only in a generated mockup.

## 13. Official Apple source library

**Primary index**

- [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Design Principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)
- [Foundations](https://developer.apple.com/design/human-interface-guidelines/foundations)

**Foundations and visual design**

- [Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- [Writing](https://developer.apple.com/design/human-interface-guidelines/writing)
- [Privacy](https://developer.apple.com/design/human-interface-guidelines/privacy)
- [SF Symbols](https://developer.apple.com/sf-symbols/)

**Controls and patterns**

- [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
- [Search Fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)
- [Searching](https://developer.apple.com/design/human-interface-guidelines/searching)
- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Progress Indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)
- [Design Tips: UI Dos and Don’ts](https://developer.apple.com/design/tips/)

**Design files and official templates**

- [Apple Design Resources](https://developer.apple.com/design/resources/)
- [macOS UI Kit and templates](https://developer.apple.com/design/resources/)

### Research protocol for future tasks

When a fresh task begins, check the HIG index and the relevant pages above for updates. For a native Apple app, consult the corresponding platform-specific guidance and official UI kits. For PointerDrop’s browser UI, use the HIG for principle-level guidance and use web standards for implementation details. Include the URLs of sources consulted in the design brief or review notes.

---

## 14. Reusable instruction to paste into an AI coding model

> **Follow `APPLE_HIG_AI_DESIGN_RULESET.md` for every UI design or implementation task. Before significant work, browse the relevant current Apple Human Interface Guidelines and official Apple Design Resources. Use Apple’s guidance as a source of design principles, not as permission to clone native Apple UI or as a claim of Apple endorsement. State which principles apply and distinguish Apple guidance from project-specific choices. Keep the design clear, accessible, responsive, and truthful. Implement all visible controls and relevant loading, empty, success, failure, focus, disabled, and reduced-motion states. For PointerDrop, never fabricate peers, network security claims, transfer speeds, progress, or completion status. Verify the rendered interface at desktop and narrow sidebar widths, then run the checklist in this file. Cite the official Apple pages used in your notes.**
