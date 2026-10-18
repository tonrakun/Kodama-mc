package dev.kodama.harness;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Samples the main thread's stack while a tick runs longer than a threshold, to find what causes spikes.
 * Only slow ticks are sampled, so normal ticks pay nothing but two volatile writes.
 */
final class SlowTickSampler {
    private static final long SAMPLE_INTERVAL_MS = 10;
    private static final int FRAMES = 30;

    private final Thread mainThread;
    private final long thresholdNanos;
    private final Map<String, int[]> samples = new HashMap<>();
    private volatile long tickStartNanos;
    private volatile boolean running = true;
    private Thread thread;

    SlowTickSampler(Thread mainThread, long thresholdMs) {
        this.mainThread = mainThread;
        this.thresholdNanos = thresholdMs * 1_000_000L;
    }

    void start() {
        thread = new Thread(this::run, "KodamaHarness-SlowTickSampler");
        thread.setDaemon(true);
        thread.start();
    }

    void stop() {
        running = false;
    }

    void tickStarted() {
        tickStartNanos = System.nanoTime();
    }

    void tickEnded() {
        tickStartNanos = 0;
    }

    private void run() {
        while (running) {
            try {
                Thread.sleep(SAMPLE_INTERVAL_MS);
            } catch (InterruptedException e) {
                return;
            }
            long start = tickStartNanos;
            if (start == 0 || System.nanoTime() - start < thresholdNanos) {
                continue;
            }
            StackTraceElement[] stack = mainThread.getStackTrace();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < Math.min(FRAMES, stack.length); i++) {
                sb.append(stack[i]).append('\n');
            }
            synchronized (samples) {
                samples.computeIfAbsent(sb.toString(), k -> new int[1])[0]++;
            }
        }
    }

    /** The most frequent stacks, most frequent first. */
    List<Map<String, Object>> top(int limit) {
        List<Map.Entry<String, int[]>> entries;
        synchronized (samples) {
            entries = new ArrayList<>(samples.entrySet());
        }
        entries.sort((a, b) -> Integer.compare(b.getValue()[0], a.getValue()[0]));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map.Entry<String, int[]> e : entries.subList(0, Math.min(limit, entries.size()))) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("samples", e.getValue()[0]);
            m.put("stack", e.getKey().split("\n"));
            out.add(m);
        }
        return out;
    }
}
