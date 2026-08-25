---
title: Keyboard shortcuts
description: Everything that works from anywhere in Kolibri, unless you are typing in a field.
sidebar:
  order: 1
---

Everything here works from anywhere in the app, unless you are typing in a field.

<kbd>⌘</kbd> is <kbd>Ctrl</kbd> on Windows and Linux.

| | |
|---|---|
| <kbd>⌘</kbd> <kbd>K</kbd> | Search everything and jump to it |
| <kbd>C</kbd> | New task |
| <kbd>?</kbd> | Open the guide inside the app |
| <kbd>Esc</kbd> | Close the sheet, menu or palette |
| <kbd>⌘</kbd> <kbd>↵</kbd> | Create the task, or send the comment |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move through the search results |
| <kbd>Tab</kbd> | Indent by two spaces in the editor |

## Things that are not shortcuts but feel like them

**Typing in the quick-add box.** The whole task fits on one line — see
[quick-add syntax](/reference/quick-add/). This is the one that saves the most time, and it is
not a keystroke, it is a habit.

**Pasting a screenshot.** Into a comment, a chat message or a page. It uploads and downscales
without a dialog.

**Typing `#` in any editor.** Offers projects and tasks to reference — projects first, then tasks,
matched on key, identifier or title.

**Typing `@` in any editor.** Offers people.

**Shift-clicking a second checkbox** in a list takes the range.

## Reaching everything without a mouse

Every control has a name, every interactive thing is reachable by <kbd>Tab</kbd>, focus rings are
visible, and the landmarks are real — which means a screen reader gets the structure rather than
a wall of divs.

That is checked in a real browser rather than asserted about the source, because *"it has an
`aria-label` somewhere"* is a claim that has been wrong here before: the first run of that check
found forty-four problems, including the checkbox in front of every task.
