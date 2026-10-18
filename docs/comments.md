# Comments

A comment carries one line of prose. When a comment needs a JSDoc tag such as
`@throws`, the tag lines follow the prose; they may repeat and are not subject
to the width limit. Anything longer belongs in `docs/`, with a one-line pointer
left in the code.

## The rule

`pnpm lint` runs Oxlint with `comments/single-line` from
`scripts/oxlint/comments.js`:

- A block comment with more than one line of prose is reported.
- A run of standalone `//` lines is reported as one multi-line comment.
- A prose line longer than 150 characters is reported.

JSDoc tag lines are exempt from both checks, because the spec annotations are
tags and a `@pgTrigger` statement can be long. A trailing `//` comment is one
line whatever code sits beside it, so consecutive trailing comments are not a
run.

The rule applies to every linted file, including tests and generated modules.
`scripts/oxlint/comments.test.js` drives it with in-memory fixtures, so the test
asserts the rule's contract rather than the repository's current comments.
