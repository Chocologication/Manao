package com.manao.poc4.workspaceagent;

import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;

/** Ed25519 helpers for raw 32-byte public keys carried in base64 environment values. */
public final class Ed25519Keys {
    private static final byte[] X509_ED25519_PREFIX = {
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
    };

    private Ed25519Keys() { }

    /** Extracts the raw 32-byte key from a DER X.509 SubjectPublicKeyInfo encoding. */
    public static byte[] rawPublicFromX509(byte[] x509) {
        if (x509 == null || x509.length != X509_ED25519_PREFIX.length + 32) {
            throw new IllegalArgumentException("unsupported Ed25519 public key encoding");
        }
        for (int i = 0; i < X509_ED25519_PREFIX.length; i++) {
            if (x509[i] != X509_ED25519_PREFIX[i]) {
                throw new IllegalArgumentException("unsupported Ed25519 public key encoding");
            }
        }
        return Arrays.copyOfRange(x509, X509_ED25519_PREFIX.length, x509.length);
    }

    public static String encodeRawPublicKey(byte[] raw) {
        if (raw == null || raw.length != 32) throw new IllegalArgumentException("Ed25519 public key must be 32 bytes");
        return Base64.getEncoder().encodeToString(raw);
    }

    public static byte[] decodeRawPublicKey(String base64) {
        byte[] raw = Base64.getDecoder().decode(base64 == null ? "" : base64.trim());
        if (raw.length != 32) throw new IllegalArgumentException("Ed25519 public key must decode to 32 bytes");
        return raw;
    }

    public static PublicKey publicKey(byte[] raw) {
        try {
            byte[] x509 = new byte[X509_ED25519_PREFIX.length + raw.length];
            System.arraycopy(X509_ED25519_PREFIX, 0, x509, 0, X509_ED25519_PREFIX.length);
            System.arraycopy(raw, 0, x509, X509_ED25519_PREFIX.length, raw.length);
            return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(x509));
        } catch (Exception ex) {
            throw new IllegalStateException("cannot build Ed25519 public key", ex);
        }
    }
}
