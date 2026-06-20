// Restore the dev (src/) package.json that prepack swapped out for packing.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'

const BAK = 'package.json.prepack-bak'
if (existsSync(BAK)) {
  writeFileSync('package.json', readFileSync(BAK, 'utf8'))
  rmSync(BAK)
}
