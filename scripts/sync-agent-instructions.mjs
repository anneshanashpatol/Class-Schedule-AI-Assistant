import { readFile, writeFile } from 'node:fs/promises';

const source = await readFile(new URL('../server/COURSE_ASSISTANT.md', import.meta.url), 'utf8');
const target = new URL('../server/agent-instructions.generated.ts', import.meta.url);
const generated = `// 由 scripts/sync-agent-instructions.mjs 根据 COURSE_ASSISTANT.md 生成，请勿手动修改。\nexport const agentInstructions = ${JSON.stringify(source)};\n`;
await writeFile(target, generated);
