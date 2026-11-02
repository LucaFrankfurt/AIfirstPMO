// @kolibri-day/feedback — the isomorphic core: the report shape, the target contract,
// the Markdown formatter, the privacy notice, messages, and the in-memory targets.
// No Node or DOM APIs; safe to import from server and browser code alike.
export * from './kernel/feedback/types.ts';
export * from './kernel/feedback/messages.ts';
export * from './kernel/feedback/format.ts';
export * from './kernel/feedback/notice.ts';
export * from './kernel/feedback/fake-target.ts';
export * from './kernel/feedback/files.ts';
