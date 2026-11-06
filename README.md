# LazyVR

**Look around 360° videos with your head.**

LazyVR is a privacy-first hosted web player that uses your webcam to turn your head movements into a view inside a 360° video. Take a quiet trip underwater, wander through a city, or ride a roller coaster from your desk. All you need is a browser and a webcam. No headset or system installation. Everything is entirely local (aside from YouTube video embeds). Webcam footage stays on-device and is never saved anywhere. 

Browse YouTube's 360° videos by category, search for something specific, or open a 360° video file from your own device. (You can also watch without a camera and drag to look around.)

## Watching a video

1. Open the site and choose a video from the library or search results.
2. Choose **Use camera** and allow webcam access when your browser asks.
3. Face the screen and hold still briefly. LazyVR finds your neutral position automatically.
4. Turn your head to look around. Press **C** whenever you want to recenter.

Small head movements move the view with you. Hold your head turned farther to either side and the view keeps turning, so you can explore the full scene while staying seated in front of the screen. Looking away or losing tracking holds the view still.

Prefer the mouse? Choose **Watch without camera**, or turn tracking off at any time. Dragging also works alongside head tracking.

## What you can do

- **Explore the library.** Browse Nature, Thrill, Ocean, Wildlife, Cities, Space, Flight, and Music, or search YouTube's 360° uploads.
- **Play your own footage.** Use **Play a file…** or drop a video onto the page. Local playback expects equirectangular 360° footage (the flat panorama format used by many 360° cameras) and a format your browser can decode.
- **Adjust the feel.** Change sensitivity, turn speed, field of view, and camera position. Optional eye assist adds a small nudge in the direction you're looking.
- **Set picture quality.** Automatic quality selection accounts for your display and decoding capabilities, with a maximum-quality setting when you want more control. YouTube ultimately chooses the stream it delivers.
- **Keep your preferences.** Settings are saved in your browser and apply as you change them.

## Controls

The player controls appear when you move the pointer and fade away while you watch. Click the video to play or pause, double-click for fullscreen, and drag to look around.

| Key | Action |
| --- | --- |
| **Space** / **K** | Play or pause |
| **←** / **→** | Seek backward or forward 5 seconds |
| **J** / **L** | Seek backward or forward 10 seconds |
| **↑** / **↓** | Adjust volume |
| **M** | Mute |
| **F** | Toggle fullscreen |
| **C** | Recenter the view |
| **T** | Toggle head tracking |
| **,** | Open settings |
| **Esc** | Close settings or return to the library; exits fullscreen first |
| **?** | Show keyboard shortcuts |

## How it works

Most of LazyVR runs in your browser:

1. **Track your head.** MediaPipe FaceLandmarker detects facial landmarks from webcam frames. A custom pose estimator uses those landmarks to work out how your head is turned relative to the screen. Tracking runs in a web worker where supported, with a fallback on the page.
2. **Turn movement into steering.** Filtering smooths out jitter. Small turns directly position the view; larger, held turns keep rotating it. Automatic centering adapts to your resting posture, and optional eye assist adds a subtle offset from iris movement.
3. **Move the video view.** YouTube videos play directly in YouTube's embedded player, controlled through its spherical-video API. Local files use a WebGL2 renderer that draws the video on the inside of a sphere.

A small Python API supplies the library and search results using **yt-dlp** with YouTube's 360° search filter. Results are cached to reduce repeated searches. The API handles discovery; video playback goes directly between your browser and YouTube, or reads from your device for local files.

## Privacy

- Webcam frames are processed on your device. LazyVR does not upload or record them.
- The camera is released when you leave the player, disable tracking, or hide the tab. It resumes when you return if tracking is still enabled.
- Local 360 video files stay on your device and are never uploaded.
- Preferences are stored locally in your browser.
- YouTube playback uses YouTube's own embed, including its usual network requests, ads, and playback restrictions. The face model is served by LazyVR; the MediaPipe runtime loads from jsDelivr.

## A few things to know

LazyVR is designed around watching on a laptop or desktop with a webcam. Give the camera a clear view of your face, and use the **Camera position** setting if it sits below or beside your screen.

For local files, MP4 or WebM with H.264 or VP9 is a good starting point; actual support depends on your browser. Local playback requires WebGL2. Ordinary flat videos won't become 360° footage just by opening them here.

YouTube search and playback depend on YouTube being available. Some uploads restrict embedding or access by region or age, and the library can be temporarily unavailable if YouTube refuses search requests. You can still play a file from your device.