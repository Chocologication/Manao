package com.manao.poc4.log;

import java.util.ArrayList;
import java.util.List;

/**
 * Splits UTF-8 text into byte-bounded chunks without cutting a code point (surrogate pairs stay
 * together). Each piece's UTF-8 byte length is at most {@code maxUtf8Bytes}; newlines stay inside
 * the piece they belong to, so a persisted chunk is always a self-contained slice of a line.
 */
public final class Utf8ChunkSplitter {

    private Utf8ChunkSplitter() { }

    public static List<String> split(String text, int maxUtf8Bytes) {
        if (maxUtf8Bytes <= 0) throw new IllegalArgumentException("maxUtf8Bytes must be positive");
        List<String> pieces = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        int currentBytes = 0;
        int index = 0;
        while (index < text.length()) {
            int codePoint = text.codePointAt(index);
            int width = Character.charCount(codePoint);
            int bytes = utf8Bytes(codePoint);
            if (currentBytes > 0 && currentBytes + bytes > maxUtf8Bytes) {
                pieces.add(current.toString());
                current.setLength(0);
                currentBytes = 0;
            }
            current.appendCodePoint(codePoint);
            currentBytes += bytes;
            index += width;
        }
        if (current.length() > 0) pieces.add(current.toString());
        return pieces;
    }

    private static int utf8Bytes(int codePoint) {
        if (codePoint <= 0x7F) return 1;
        if (codePoint <= 0x7FF) return 2;
        if (codePoint <= 0xFFFF) return 3;
        return 4;
    }
}
