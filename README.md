# Baby's first HTML5 &lt;video&gt; element

A basic partial re-implementation of the HTML5 &lt;video&gt; element, to explain the inner workings of video playback in
a browser.

This is purely for demonstration purposes. Don't use this in production, use a real `<video>` element instead.

## Features

- ▶️ `<baby-video>` custom element behaves like a [`<video>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video)
- 🚰 `BabyMediaSource` class behaves like a [`MediaSource`](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource), allowing adaptive streaming
- ⏪ Supports reverse playback through negative `playbackRate`

## Talks

- [Demuxed 2022: Baby's first HTML5 video element](https://youtu.be/OBhlTcllq_E?si=5OD36WN5T7OoptzB)
- Demuxed 2023: The curious player of Benjamin Button: reverse video on the web
