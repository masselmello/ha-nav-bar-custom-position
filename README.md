# Navbar Position

A Home Assistant frontend plugin that allows the navigation bar to be moved to the bottom of the screen. 

# Note: This repo has been updated to work with HA versions > 2023.04, it will not work on anything lower, please keep this in mind if you open an issue and are using an older version. 

![screenshot](images/screenshot.png)

# Installation

Install via HACS by searching for "Navbar Position".

Or install manually by dropping `ha-navbar-position.js` into your Lovelace dashboard resources.

# Usage

## Via the URL

The primary way this plugin is activated is by adding `navbar=bottom` to the dashboard URL, like so:

```
http://<hass>:8123/some-dashboard/some-view?navbar=bottom
```

The navigation bar will be moved to the bottom of the screen until the next page refresh.

To save the navigation bar position to `localStorage` and move the navbar to the bottom automatically without having to specify `navbar=bottom` every time, use `navbar_cache`:

```
http://<hass>:8123/some-dashboard/some-view?navbar=bottom&navbar_cache
```

Thereafter, page loads that don't specify any `navbar` query parameters will default to moving the navbar to the bottom.

To clear the saved position and return the navbar to the top on future page loads, use `navbar_cache` without `navbar=...` (or with `navbar=top`):

```
http://<hass>:8123/some-dashboard/some-view?navbar_cache
```

`navbar=top` also works without `navbar_cache` to show the navbar at the top for a single page load, even if `bottom` is saved. Values other than `bottom` and `top` are treated as `top`.

There will likely be additional ways to configure this plugin in the future - pull requests gladly accepted.

## Via custom card

For scenarios where it isn't possible to edit the URL directly (e.g. when using the Home Assistant mobile apps), you can toggle the navigation bar position on a per-device basis using the `Navbar Position Configuration Card` custom card.

Add it to a dashboard of your choosing. The card shows the position saved on the current device ("Saved position on this device: top" or "bottom"). Click its "Move navigation bar to the bottom" button on any device where you want the navbar at the bottom of the screen; on a device where it is already at the bottom, the button reads "Move navigation bar to the top". The button saves the change to `localStorage` and reloads the page; you can then get rid of the card and the navbar will continue to show up at the bottom of the screen on the device in question.

# Limitations

This only moves the dashboard navigation bar; it doesn't move navigation bars associated with any other screens. PRs welcome to handle that as well.

The plugin relies on internal parts of the Home Assistant frontend. A Home Assistant update that changes them can stop the navbar from moving; check the browser console for "Navbar Position" messages when reporting an issue.

