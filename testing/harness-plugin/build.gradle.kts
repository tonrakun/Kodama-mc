dependencies {
    // Paper API (not kodama-api) so the same jar loads on vanilla Paper and on Kodama.
    compileOnly("io.papermc.paper:paper-api:1.20.6-R0.1-SNAPSHOT")
}

tasks.jar {
    archiveFileName = "kodama-harness.jar"
}
