# Style & Conventions
- Use React function components with hooks; keep logic in `App.tsx` until the UI grows, then extract helpers/components as needed.
- Favor TypeScript types/aliases for parsed data (e.g., `ParsedData`, `TimeParts`) and utility functions for parsing/formatting instead of inline logic.
- Keep UI styling in the existing CSS files (no CSS-in-JS); follow current naming pattern (`app-shell`, `series-panel`, etc.).
- Parsing helpers should gracefully handle malformed rows (skip/throw) and return `null` for missing numeric values so Chart.js can span gaps.
- Stick to ASCII text when editing files unless data demands otherwise.