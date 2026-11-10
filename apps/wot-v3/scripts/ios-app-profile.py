#!/usr/bin/env python3
"""Names the provisioning profile in the Release configuration of the App target only.

Usage: scripts/ios-app-profile.py <App.xcodeproj/project.pbxproj> <profile name>

Used by build-ios.sh for a signed build, on the CI checkout (never committed: the project carries no
team and no profile, tests/ios-shell.test.ts). Why not PROVISIONING_PROFILE_SPECIFIER on the xcodebuild
command line: a command-line build setting applies to every target, and the resource-bundle targets of
Swift packages (ZIPFoundation, Alamofire, brought by the live-update plugin) refuse a profile ("does not
support provisioning profiles"), which fails the archive.
"""
import re
import sys

path, name = sys.argv[1], sys.argv[2]
if not name or '"' in name or '\\' in name or '\n' in name:
    sys.exit(f"ios-app-profile: unusable profile name {name!r}")
text = open(path, encoding="utf-8").read()

block = re.compile(
    r"(\t\t[0-9A-F]{24} /\* Release \*/ = \{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = \{\n)"
    r"(.*?)"
    r"(\t\t\t\};\n\t\t\tname = Release;\n)",
    re.S,
)
app = [m for m in block.finditer(text) if "PRODUCT_BUNDLE_IDENTIFIER = org.reallife.weboftrust;" in m.group(2)]
if len(app) != 1:
    sys.exit(f"ios-app-profile: expected one Release configuration of the App target, found {len(app)}")
m = app[0]
settings = m.group(2)
if "PROVISIONING_PROFILE_SPECIFIER" in settings:
    sys.exit("ios-app-profile: the App target names a profile already")
settings += f'\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "{name}";\n'
text = text[: m.start(2)] + settings + text[m.end(2):]
open(path, "w", encoding="utf-8").write(text)
print(f"    profile '{name}' set on the Release configuration of the App target")
