import { readFileSync } from 'fs';
import { join } from 'path';

// Путь к lua/ в корне проекта (работает и для src/ и для dist/)
const LUA_DIR = join(__dirname, '../../lua');

function loadScript(name: string): string {
  return readFileSync(join(LUA_DIR, `${name}.lua`), 'utf-8');
}

export const LuaScripts = {
  makeBet: loadScript('makeBet'),
  deleteBet: loadScript('deleteBet'),
} as const;
