# Project rules

- Keep ChatGPT Web in charge of reasoning, conversation context, and tool orchestration. This is a tool bridge, not another autonomous model harness.
- Read the files involved, make the smallest complete change, and run focused tests followed by `bun run verify`. Do not add abstraction layers without a demonstrated need.
- Never stop/restart a live tunnel or native tool host as a side effect of editing, testing, or publishing. Do not modify user/global permissions. New install work must be explicit and confined to its owned configuration.
- Use temporary directories and fake executors in tests. Never infer that a timeout means a side effect did not happen. Never automatically replay uncertain actions.
- Preserve raw media/structured tool results and native errors. Do not fabricate success, missing images, or unsupported schemas.
- Do not read or publish private state, tokens, cookies, production logs, or full native task transcripts. Keep upstream attribution.
- Do not claim fresh end-to-end Desktop acceptance based only on mocks, protocol tests, or the original working deployment.
