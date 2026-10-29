// The shared config skips the state directory and any lib/ on its own; the local helpers are not
// covered by that, and linting them reports findings in scripts that never ship.
import { defineConfig } from '@1stg/eslint-config'

export default (async () => [{ ignores: ['.tasks/**'] }, ...(await defineConfig())])()
