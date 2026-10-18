package dev.kodama.harness;

import java.util.Arrays;

final class Stats {
    private Stats() {}

    /** Growable primitive buffer; avoids boxing one Double per tick. */
    static final class DoubleList {
        private double[] data = new double[4096];
        private int size;

        void add(double v) {
            if (size == data.length) {
                data = Arrays.copyOf(data, size * 2);
            }
            data[size++] = v;
        }

        int size() {
            return size;
        }

        double[] toArray() {
            return Arrays.copyOf(data, size);
        }
    }

    /** Nearest-rank percentile over an already sorted array; p in (0, 100]. */
    static double percentile(double[] sorted, double p) {
        if (sorted.length == 0) {
            return 0;
        }
        int rank = (int) Math.ceil(p / 100.0 * sorted.length);
        return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
    }

    static double avg(double[] values) {
        if (values.length == 0) {
            return 0;
        }
        double sum = 0;
        for (double v : values) {
            sum += v;
        }
        return sum / values.length;
    }

    static double max(double[] values) {
        double m = 0;
        for (double v : values) {
            m = Math.max(m, v);
        }
        return m;
    }
}
