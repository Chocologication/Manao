package com.manao.poc4.ai.studio;

import static com.manao.poc4.ai.studio.StudioContracts.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.springframework.jdbc.core.JdbcTemplate;

public final class StudioAttachments {
    public static final int MAX_BYTES = 8 * 1024 * 1024;
    private static final int MAX_TEXT = 60000;
    private static final java.util.concurrent.Semaphore PARSERS = new java.util.concurrent.Semaphore(2);
    static {
        org.apache.poi.openxml4j.util.ZipSecureFile.setMaxEntrySize(16 * 1024 * 1024);
        org.apache.poi.openxml4j.util.ZipSecureFile.setMaxTextSize(2 * 1024 * 1024);
        org.apache.poi.openxml4j.util.ZipSecureFile.setMaxFileCount(1000);
    }
    private final StudioStore store;
    private final JdbcTemplate jdbc;
    private final org.springframework.transaction.support.TransactionTemplate tx;
    public StudioAttachments(StudioStore store, JdbcTemplate jdbc) {
        this.store = store; this.jdbc = jdbc;
        this.tx = new org.springframework.transaction.support.TransactionTemplate(new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()));
    }
    public record Data(Attachment view, byte[] body, String text) { }
    public Attachment upload(String owner, String project, Upload upload) {
        store.requireProject(owner, project);
        if (upload == null || upload.base64() == null || upload.base64().length() > MAX_BYTES * 4 / 3 + 8) throw StudioStore.invalid();
        String name = StudioStore.bounded(upload.name(), 255).replaceAll("[\\\\/\\p{Cntrl}]", "_");
        byte[] bytes;
        try { bytes = Base64.getDecoder().decode(upload.base64()); } catch (Exception ex) { throw StudioStore.invalid(); }
        if (bytes.length == 0 || bytes.length > MAX_BYTES) throw StudioStore.invalid();
        String type = detect(bytes, name); String text = "";
        if (!PARSERS.tryAcquire()) throw new com.manao.poc4.api.ApiException("AI_BUSY", 429, "Attachment parsers are busy");
        try {
            if (type.startsWith("image/")) {
                validateImage(bytes, type);
            } else if (type.equals("application/pdf")) {
                try (var pdf = Loader.loadPDF(bytes)) {
                    var stripper = new PDFTextStripper(); stripper.setEndPage(Math.min(100, pdf.getNumberOfPages()));
                    var writer = new java.io.Writer() {
                        final StringBuilder value = new StringBuilder();
                        @Override public void write(char[] chars, int offset, int length) { int remaining = MAX_TEXT + 1 - value.length(); if (remaining > 0) value.append(chars, offset, Math.min(remaining, length)); }
                        @Override public void flush() { }
                        @Override public void close() { }
                        @Override public String toString() { return value.toString(); }
                    };
                    stripper.writeText(pdf, writer); text = writer.toString();
                }
            } else if (type.contains("wordprocessingml")) {
                try (var document = new XWPFDocument(new ByteArrayInputStream(bytes))) {
                    StringBuilder value = new StringBuilder();
                    for (var paragraph : document.getParagraphs()) { if (value.length() > MAX_TEXT) break; value.append(paragraph.getText()).append('\n'); }
                    for (var table : document.getTables()) for (var row : table.getRows()) { if (value.length() > MAX_TEXT) break; for (var cell : row.getTableCells()) value.append(cell.getText()).append('\t'); value.append('\n'); }
                    text = value.toString();
                }
            } else if (type.equals("text/plain")) {
                text = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString();
                if (text.indexOf('\0') >= 0) throw StudioStore.invalid();
            }
        } catch (Exception ex) { throw new com.manao.poc4.api.ApiException("VALIDATION_ERROR", 422, "Attachment could not be parsed; use a text PDF, DOCX or UTF-8 file"); }
        finally { PARSERS.release(); }
        boolean truncated = text.length() > MAX_TEXT;
        if (truncated) text = text.substring(0, MAX_TEXT);
        String id = UUID.randomUUID().toString();
        String extracted = text;
        tx.executeWithoutResult(status -> {
            // Serialize quota allocation across this owner's projects and concurrent uploads.
            jdbc.queryForObject("SELECT id FROM app_user WHERE id=? FOR UPDATE", String.class, owner);
            jdbc.update("DELETE a FROM assistant_attachment a WHERE a.owner_id=? AND a.created_at<? AND NOT EXISTS (SELECT 1 FROM assistant_turn t JOIN assistant_conversation c ON c.id=t.conversation_id WHERE c.project_id=a.project_id AND JSON_CONTAINS(JSON_EXTRACT(t.data_json,'$.attachmentIds'),JSON_QUOTE(a.id)))", owner, Timestamp.from(Instant.now().minus(7, java.time.temporal.ChronoUnit.DAYS)));
            Long stored = jdbc.queryForObject("SELECT COALESCE(SUM(OCTET_LENGTH(body)),0) FROM assistant_attachment WHERE owner_id=?", Long.class, owner);
            if (stored != null && stored + bytes.length > 128L * 1024 * 1024) throw new com.manao.poc4.api.ApiException("FILE_TOO_LARGE", 422, "Attachment storage limit reached");
            jdbc.update("INSERT INTO assistant_attachment(id,owner_id,project_id,filename,media_type,body,extracted_text,truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                id, owner, project, name, type, bytes, extracted, truncated, Timestamp.from(Instant.now()));
        });
        return new Attachment(id, name, type, bytes.length, truncated);
    }
    private static void validateImage(byte[] bytes, String type) throws java.io.IOException {
        int width, height;
        if (type.equals("image/webp")) {
            var input = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN);
            if (bytes.length < 30 || Integer.toUnsignedLong(input.getInt(4)) + 8 != bytes.length) throw StudioStore.invalid();
            String chunk = new String(bytes, 12, 4, StandardCharsets.US_ASCII);
            if (chunk.equals("VP8X")) { width = 1 + uint24(bytes, 24); height = 1 + uint24(bytes, 27); }
            else if (chunk.equals("VP8 ") && bytes[23] == (byte)0x9d && bytes[24] == 1 && bytes[25] == 0x2a) { width = input.getShort(26) & 0x3fff; height = input.getShort(28) & 0x3fff; }
            else if (chunk.equals("VP8L") && bytes[20] == 0x2f) { int bits = input.getInt(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
            else throw StudioStore.invalid();
        } else {
            try (var input = javax.imageio.ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
                var readers = javax.imageio.ImageIO.getImageReaders(input);
                if (!readers.hasNext()) throw StudioStore.invalid();
                var reader = readers.next();
                try { reader.setInput(input, true, true); width = reader.getWidth(0); height = reader.getHeight(0); }
                finally { reader.dispose(); }
            }
        }
        if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || (long)width * height > 16_000_000) throw StudioStore.invalid();
    }
    private static int uint24(byte[] bytes, int offset) { return (bytes[offset] & 255) | (bytes[offset + 1] & 255) << 8 | (bytes[offset + 2] & 255) << 16; }
    public Data get(String owner, String project, String id) {
        store.requireProject(owner, project);
        List<Data> rows = jdbc.query("SELECT * FROM assistant_attachment WHERE id=? AND owner_id=? AND project_id=?", (rs, i) ->
            new Data(new Attachment(rs.getString("id"), rs.getString("filename"), rs.getString("media_type"), rs.getBytes("body").length, rs.getBoolean("truncated")), rs.getBytes("body"), rs.getString("extracted_text")), id, owner, project);
        if (rows.isEmpty()) throw StudioStore.missing(); return rows.get(0);
    }
    public static String detect(byte[] bytes, String name) {
        if (bytes.length > 8 && bytes[0] == (byte) 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G') return "image/png";
        if (bytes.length > 3 && bytes[0] == (byte) 0xff && bytes[1] == (byte) 0xd8 && bytes[2] == (byte) 0xff) return "image/jpeg";
        if (bytes.length > 12 && new String(bytes, 0, 4, StandardCharsets.US_ASCII).equals("RIFF") && new String(bytes, 8, 4, StandardCharsets.US_ASCII).equals("WEBP")) return "image/webp";
        if (bytes.length > 5 && new String(bytes, 0, 5, StandardCharsets.US_ASCII).equals("%PDF-")) return "application/pdf";
        if (name.toLowerCase(java.util.Locale.ROOT).endsWith(".docx") && bytes.length > 2 && bytes[0] == 'P' && bytes[1] == 'K') return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (name.matches("(?i).+\\.(txt|md|java|py|ts|tsx|js|jsx|json|xml|yml|yaml|csv|log|html|css|sql)$")) return "text/plain";
        throw new com.manao.poc4.api.ApiException("VALIDATION_ERROR", 422, "Use PNG, JPEG, WebP, PDF, DOCX or UTF-8 text");
    }
}
