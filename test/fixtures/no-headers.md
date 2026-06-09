This is a document without any markdown headers.

It has paragraphs of text but no h1, h2, h3, or any other heading markers. The chunker should handle this by falling back to paragraph-level chunking.

Here is a code block:

```python
def hello():
    print("Hello, world!")
```

More text after the code block. This helps test the paragraph splitting logic.

Another paragraph with more content to ensure we have enough text to trigger splitting behavior. The chunker should merge adjacent small paragraphs and preserve code fences.
