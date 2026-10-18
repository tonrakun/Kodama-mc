package dev.kodama.harness;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class Json {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private Json() {}

    static void write(Path file, Object value) throws IOException {
        Files.createDirectories(file.toAbsolutePath().getParent());
        Files.writeString(file, GSON.toJson(value), StandardCharsets.UTF_8);
    }
}
