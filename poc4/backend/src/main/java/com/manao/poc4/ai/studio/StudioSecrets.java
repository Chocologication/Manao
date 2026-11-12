package com.manao.poc4.ai.studio;

import com.manao.poc4.api.ApiException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** AES-GCM binds every ciphertext to its account and model; no plaintext fallback. */
public final class StudioSecrets {
    private final byte[] key;
    public StudioSecrets(String encodedKey) {
        byte[] decoded;
        try { decoded = Base64.getDecoder().decode(encodedKey == null ? "" : encodedKey); }
        catch (IllegalArgumentException ex) { decoded = new byte[0]; }
        key = decoded.length == 32 ? decoded : null;
    }
    public String encrypt(String owner, String id, String plaintext) {
        requireKey();
        try {
            byte[] nonce = new byte[12]; new SecureRandom().nextBytes(nonce);
            var cipher = cipher(Cipher.ENCRYPT_MODE, nonce, owner, id);
            byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(ByteBuffer.allocate(12 + encrypted.length).put(nonce).put(encrypted).array());
        } catch (Exception ex) { throw unavailable(); }
    }
    public String decrypt(String owner, String id, String ciphertext) {
        requireKey();
        try {
            byte[] bytes = Base64.getDecoder().decode(ciphertext);
            if (bytes.length < 28) throw unavailable();
            byte[] nonce = java.util.Arrays.copyOf(bytes, 12);
            return new String(cipher(Cipher.DECRYPT_MODE, nonce, owner, id)
                .doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8);
        } catch (Exception ex) { throw unavailable(); }
    }
    private Cipher cipher(int mode, byte[] nonce, String owner, String id) throws Exception {
        var cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD((owner + "\0" + id).getBytes(StandardCharsets.UTF_8));
        return cipher;
    }
    private void requireKey() { if (key == null) throw unavailable(); }
    private static ApiException unavailable() { return new ApiException("AI_CREDENTIALS_UNAVAILABLE", 503, "Model credentials are unavailable"); }
}
