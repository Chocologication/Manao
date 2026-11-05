package com.manao.poc4.ai.studio;

import static com.manao.poc4.ai.studio.StudioContracts.*;
import com.manao.poc4.api.ApiException;
import java.net.InetAddress;
import java.net.URI;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

public final class StudioModelStore {
    private final JdbcTemplate jdbc;
    private final StudioSecrets secrets;
    public StudioModelStore(JdbcTemplate jdbc, StudioSecrets secrets) { this.jdbc = jdbc; this.secrets = secrets; }
    public List<ModelView> list(String owner) {
        return jdbc.query("SELECT * FROM assistant_model WHERE owner_id=? ORDER BY updated_at DESC LIMIT 50",
            (rs, i) -> new ModelView(rs.getString("id"), rs.getString("label"), rs.getString("base_url"),
                rs.getString("model_name"), rs.getBoolean("vision"), rs.getBoolean("tools"), true), owner);
    }
    public ModelView save(String owner, ModelInput input) {
        if (input == null) throw StudioStore.invalid();
        String id = input.id() == null || input.id().isBlank() ? UUID.randomUUID().toString() : StudioStore.uuid(input.id());
        String label = StudioStore.bounded(input.label(), 80), model = StudioStore.bounded(input.model(), 160);
        String base = validateAddress(input.baseUrl());
        List<String> old = jdbc.query("SELECT encrypted_key FROM assistant_model WHERE id=? AND owner_id=?", (rs, i) -> rs.getString(1), id, owner);
        if (old.isEmpty() && Boolean.TRUE.equals(jdbc.queryForObject("SELECT COUNT(*)>0 FROM assistant_model WHERE id=?", Boolean.class, id))) throw StudioStore.missing();
        String encrypted;
        if (input.apiKey() == null || input.apiKey().isBlank()) {
            if (old.isEmpty()) throw StudioStore.invalid();
            encrypted = old.get(0);
        } else {
            if (input.apiKey().length() > 4096 || input.apiKey().contains("\n") || input.apiKey().contains("\r")) throw StudioStore.invalid();
            encrypted = secrets.encrypt(owner, id, input.apiKey().trim());
        }
        if (old.isEmpty()) {
            if (list(owner).size() >= 50) throw StudioStore.invalid();
            jdbc.update("INSERT INTO assistant_model(id,owner_id,label,base_url,model_name,encrypted_key,vision,tools,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                id, owner, label, base, model, encrypted, input.vision(), input.tools(), Timestamp.from(Instant.now()));
        } else jdbc.update("UPDATE assistant_model SET label=?,base_url=?,model_name=?,encrypted_key=?,vision=?,tools=?,updated_at=? WHERE id=? AND owner_id=?",
            label, base, model, encrypted, input.vision(), input.tools(), Timestamp.from(Instant.now()), id, owner);
        return new ModelView(id, label, base, model, input.vision(), input.tools(), true);
    }
    public ModelSecret resolve(String owner, String id) {
        var rows = jdbc.query("SELECT * FROM assistant_model WHERE owner_id=? AND id=?", (rs, i) ->
            new ModelSecret(id, rs.getString("base_url"), rs.getString("model_name"),
                secrets.decrypt(owner, id, rs.getString("encrypted_key")), rs.getBoolean("vision"), rs.getBoolean("tools")), owner, id);
        if (rows.isEmpty()) throw StudioStore.missing();
        return rows.get(0);
    }
    public void delete(String owner, String id) { jdbc.update("DELETE FROM assistant_model WHERE owner_id=? AND id=?", owner, id); }
    public static String validateAddress(String value) {
        try {
            URI uri = URI.create(value == null ? "" : value.trim());
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null || value.length() > 1024) throw StudioStore.invalid();
            for (InetAddress address : InetAddress.getAllByName(uri.getHost())) {
                if (!publicAddress(address)) throw StudioStore.invalid();
            }
            return uri.toString().replaceAll("/+$", "");
        } catch (ApiException ex) { throw ex; }
        catch (Exception ex) { throw new ApiException("VALIDATION_ERROR", 422, "A public HTTPS model API address is required"); }
    }
    static boolean publicAddress(InetAddress address) {
        byte[] raw = address.getAddress();
        if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
            || address.isSiteLocalAddress() || address.isMulticastAddress()) return false;
        if (raw.length == 16) return (raw[0] & 0xe0) == 0x20; // Public global-unicast only; rejects mapped/translation ranges.
        int first = raw[0] & 255, second = raw[1] & 255;
        return first > 0 && first < 224 && !(first == 100 && second >= 64 && second <= 127)
            && !(first == 169 && second == 254) && !(first == 192 && second == 0)
            && !(first == 198 && (second == 18 || second == 19));
    }
}
