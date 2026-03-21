# Sparrow Privacy Extension

## How to load
1. go to chrome extensions
2. manage extensions
3. turn on developer mode
4. "load unpacked" in top left
5. select this folder
6. generate a gemini API key [here](https://ai.google.dev/gemini-api/docs/api-key?authuser=1)
7. paste the key and save in the settings, top-right of the extension popup


## Files
- manifest.json: extension config
- background.js: extension service worker
- popup.html, popup.js: main extension UI popup
- options.html, options.js: extension settings management
- output-structure.js: heuristic privacy report generation and rendering helpers
- ai.js: Gemini request layer and error handling
- ai-report-interpretation.js: prompt building, response validation, and report merge logic

## How does it work
- detects a website’s privacy policy page by scanning the current page, homepage, and fallback locations
- fetches the privacy policy text and removes interface noise so the policy content is easier to analyze
- breaks policy down into structured sections
- organizes policy content into privacy categories using matching rules
- apply rules to determine how each category is handled and gathers evidence for those decisions
- sends the structured analysis through an LLM to generate the final report in clearer plain language
- apply rules to estimate how each cateogry of data is handled
- displays results in a report that prioritizes most important first, with ability to expand sections to learn more
- sources linked for user to investigate themselves
