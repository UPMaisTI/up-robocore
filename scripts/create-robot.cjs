#!/usr/bin/env node
/* eslint-disable */
const fs = require('fs');
const path = require('path');

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Uso: npm run robot:create <nome>');
    process.exit(1);
  }
  const safe = name.replace(/[^a-zA-Z0-9-_]/g, '');
  const baseDir = path.join(process.cwd(), 'src', 'robots', safe);
  const indexFile = path.join(baseDir, 'index.ts');

  if (fs.existsSync(indexFile)) {
    console.error(`Robô já existe: ${indexFile}`);
    process.exit(1);
  }

  fs.mkdirSync(baseDir, { recursive: true });

  const template = `import type { Robot, RobotContext } from '../types'

let timer: NodeJS.Timeout | null = null

const robot: Robot = {
  name: '${safe}',
  async start(ctx: RobotContext) {
    ctx.log('iniciando...')
    if (timer) return
    timer = setInterval(() => {
      ctx.log('tick')
    }, 5000)
  },
  async stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  },
  async status() {
    return { ticking: Boolean(timer) }
  },
}

export default robot
`;
  fs.writeFileSync(indexFile, template, 'utf-8');
  console.log(`Robô criado: ${indexFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
