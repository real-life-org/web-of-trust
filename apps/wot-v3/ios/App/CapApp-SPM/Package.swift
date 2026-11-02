// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.0"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.pnpm/@capacitor+app@8.1.0_@capacitor+core@8.3.0/node_modules/@capacitor/app"),
        .package(name: "CapacitorClipboard", path: "../../../../../node_modules/.pnpm/@capacitor+clipboard@8.0.1_@capacitor+core@8.3.0/node_modules/@capacitor/clipboard"),
        .package(name: "CapacitorFilesystem", path: "../../../../../node_modules/.pnpm/@capacitor+filesystem@8.1.5_@capacitor+core@8.3.0/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorLocalNotifications", path: "../../../../../node_modules/.pnpm/@capacitor+local-notifications@8.3.1_@capacitor+core@8.3.0/node_modules/@capacitor/local-notifications"),
        .package(name: "CapacitorShare", path: "../../../../../node_modules/.pnpm/@capacitor+share@8.0.3_@capacitor+core@8.3.0/node_modules/@capacitor/share"),
        .package(name: "RealLifeOrgCapacitorZxingScanner", path: "../../../../../node_modules/.pnpm/@real-life-org+capacitor-zxing-scanner@1.1.3_@capacitor+core@8.3.0/node_modules/@real-life-org/capacitor-zxing-scanner"),
        .package(name: "CapacitorEmailComposer", path: "../../../../../node_modules/.pnpm/capacitor-email-composer@8.0.0_@capacitor+core@8.3.0/node_modules/capacitor-email-composer")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorClipboard", package: "CapacitorClipboard"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorLocalNotifications", package: "CapacitorLocalNotifications"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "RealLifeOrgCapacitorZxingScanner", package: "RealLifeOrgCapacitorZxingScanner"),
                .product(name: "CapacitorEmailComposer", package: "CapacitorEmailComposer")
            ]
        )
    ]
)
