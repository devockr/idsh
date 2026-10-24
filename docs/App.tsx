import { lazy, Suspense, useMemo } from 'react'
import {
  BrowserRouter as Router,
  Route,
  Routes,
  useParams,
} from 'react-router-dom'

import './global.css'
import 'github-markdown-css'

/**
 * One component per kind of page, reading the name from the route: absent is the repository root,
 * `image` the image's own changelog, anything else a package. `/CHANGELOG.md` and `/` simply match no
 * `:name`, so they need no separate component.
 *
 * `lazy()` is memoised by name rather than called per render: it returns a new component type every
 * time, and a new type remounts the subtree — losing scroll position, refetching the chunk and
 * re-running effects. `useMemo` is a hint React may discard, which here costs at most that remount.
 */
const Readme = () => {
  const { name } = useParams<{ name: string }>()
  const Page = useMemo(
    () =>
      lazy(() =>
        name ? import(`../packages/${name}/README.md`) : import('../README.md'),
      ),
    [name],
  )
  return (
    <Suspense>
      <Page />
    </Suspense>
  )
}

const Changelog = () => {
  const { name } = useParams<{ name: string }>()
  const Page = useMemo(
    () =>
      lazy(() => {
        if (!name) {
          return import('../CHANGELOG.md')
        }
        if (name === 'image') {
          return import('../image/CHANGELOG.md')
        }
        return import(`../packages/${name}/CHANGELOG.md`)
      }),
    [name],
  )
  return (
    <Suspense>
      <Page />
    </Suspense>
  )
}

const Roadmap = () => {
  const Page = useMemo(() => lazy(() => import('../ROADMAP.md')), [])
  return (
    <Suspense>
      <Page />
    </Suspense>
  )
}

export const App = () => (
  <Router>
    <Routes>
      <Route
        path="/ROADMAP.md"
        element={<Roadmap />}
      />
      <Route
        path="/CHANGELOG.md"
        element={<Changelog />}
      />
      <Route
        path="/:name/CHANGELOG.md"
        element={<Changelog />}
      />
      <Route
        path="/packages/:name/CHANGELOG.md"
        element={<Changelog />}
      />
      <Route
        path="/packages/:name"
        element={<Readme />}
      />
      <Route
        path="/"
        element={<Readme />}
      />
    </Routes>
  </Router>
)
