package com.manao.poc4.ai.studio;

import static com.manao.poc4.ai.studio.StudioContracts.*;
import com.github.difflib.DiffUtils;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Hunk coordinates always refer to the immutable base, including its final newline. */
public final class StudioDiff {
    private StudioDiff() { }
    public static FileChange change(String path, String before, String after) {
        var source = lines(before);
        var patch = DiffUtils.diff(source, lines(after));
        var hunks = new ArrayList<Hunk>();
        for (var delta : patch.getDeltas()) {
            int start = delta.getSource().getPosition();
            var removed = List.copyOf(delta.getSource().getLines());
            var added = List.copyOf(delta.getTarget().getLines());
            String id = StudioStore.hash(StudioStore.json(List.of(path, start, removed, added)));
            hunks.add(new Hunk(id, start, removed, added));
        }
        return new FileChange(path, before, after, before == null ? null : StudioStore.hash(before), hunks);
    }
    public static String selected(FileChange file, Set<String> selected) {
        var result = new ArrayList<>(lines(file.before()));
        var ordered = file.hunks().stream().filter(h -> selected.contains(h.id()))
            .sorted(java.util.Comparator.comparingInt(Hunk::start).reversed()).toList();
        for (var hunk : ordered) {
            if (!result.subList(hunk.start(), hunk.start() + hunk.before().size()).equals(hunk.before()))
                throw new IllegalStateException("Hunk base mismatch");
            result.subList(hunk.start(), hunk.start() + hunk.before().size()).clear();
            result.addAll(hunk.start(), hunk.after());
        }
        return String.join("\n", result);
    }
    private static List<String> lines(String text) {
        return text == null || text.isEmpty() ? List.of() : Arrays.asList(text.split("\n", -1));
    }
}
