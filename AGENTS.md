# Code style

- Keep code short, scannable, maintainable, and straight to the point.
- Use clear names and small, focused functions.
- Refactor unclear code instead of adding prose comments or JSDoc.
- Preserve comments required by compilers, tooling, or licenses.
- Use TDD and golden tests based on real use cases.

# Rules

- Establish applicability and required data in filters; checks trust those preconditions.
- Keep checks focused on policy. Do not repeat filters or guard against impossible inputs.
- Use domain names and direct comparisons so the policy reads naturally.
- Add helpers and validation only when they clarify real behavior, not hypothetical edge cases.
