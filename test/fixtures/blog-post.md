# Why Do React Hooks Rely on Call Order?

React hooks rely on call order because React uses a linked list internally to track hook state. Each hook call during a render is associated with a specific position in that list. This is why hooks must be called in the same order on every render.

## How useState Works Internally

When you call `useState`, React looks at the current position in the hooks list. If this is the first render, it creates a new state cell and appends it to the list. On subsequent renders, it reads from the same position.

```js
function useState(initialValue) {
  const hook = {
    memoizedState: initialValue,
    queue: [],
    next: null
  }
  // Append to hooks list
  if (workInProgressHook === null) {
    currentlyRenderingFiber.memoizedState = workInProgressHook = hook
  } else {
    workInProgressHook = workInProgressHook.next = hook
  }
  return [hook.memoizedState, dispatchAction]
}
```

This is why conditional hooks break React — a hook that doesn't run throws off the position mapping for every hook that follows.

## The Rules of Hooks

React enforces two main rules:

1. Only call hooks at the top level of your component
2. Only call hooks from React function components or custom hooks

```js
// ❌ Bad — conditional hook
function MyComponent({ shouldFetch }) {
  if (shouldFetch) {
    const data = useData() // Breaks if shouldFetch changes
  }
  const [name, setName] = useState('') // Position shifted
}

// ✅ Good
function MyComponent({ shouldFetch }) {
  const data = shouldFetch ? useData() : null
  const [name, setName] = useState('')
}
```

## Conclusion

Hooks are not magic. They are a clever use of call order and linked lists. Understanding the underlying mechanics helps you write better React code and debug issues faster.
