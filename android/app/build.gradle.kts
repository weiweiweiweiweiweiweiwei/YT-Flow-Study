plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 擴充功能的原始碼（repo 根目錄）就是唯一的一份。
// 打包時整份複製進 assets/ext/，App 直接載入這些檔案，不另外維護 Android 專用的副本。
val extensionRoot = rootProject.projectDir.parentFile
val extAssetsDir = layout.buildDirectory.dir("generated/extAssets")

val copyExtension by tasks.registering(Sync::class) {
    from(extensionRoot) {
        include("*.js", "*.css", "*.html", "*.png", "*.svg", "manifest.json")
        include("core/**", "pages/**")
        exclude("*.test.html", "test-fixture-*.js", "popup.*", "offscreen.*")
    }
    into(extAssetsDir.map { it.dir("ext") })
}

android {
    namespace = "com.flowstudy.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.flowstudy.app"
        minSdk = 29
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.1." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    // 只給自己用：用一把固定的金鑰簽章，這樣每次 CI 產生的新版 APK 都能直接覆蓋安裝，
    // 不必先解除安裝（解除安裝會把 App 裡的單字資料一起刪掉）。
    signingConfigs {
        create("personal") {
            storeFile = file("flowstudy-debug.keystore")
            storePassword = "flowstudy"
            keyAlias = "flowstudy"
            keyPassword = "flowstudy"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("personal")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("personal")
        }
    }

    sourceSets["main"].assets.srcDir(extAssetsDir)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

tasks.named("preBuild") { dependsOn(copyExtension) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
