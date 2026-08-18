/* global document, window */

const version = new URLSearchParams(window.location.search).get("version") ?? "0.0.0";
const versionElement = document.querySelector("#version");
if (versionElement) versionElement.textContent = `Version ${version}`;
