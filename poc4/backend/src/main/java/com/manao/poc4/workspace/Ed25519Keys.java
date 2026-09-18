package com.manao.poc4.workspace;

import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;

/** Ed25519 key handling for raw 32-byte keys exchanged as base64 environment values. */
public final class Ed25519Keys {
    private static final byte[] PKCS8_ED25519_PREFIX = {
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
    };
    private static final byte[] X509_ED25519_PREFIX = {
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
    };

    private Ed25519Keys() { }

    public static PrivateKey privateKeyFromRaw(byte[] raw) {
        try {
            byte[] pkcs8 = new byte[PKCS8_ED25519_PREFIX.length + raw.length];
            System.arraycopy(PKCS8_ED25519_PREFIX, 0, pkcs8, 0, PKCS8_ED25519_PREFIX.length);
            System.arraycopy(raw, 0, pkcs8, PKCS8_ED25519_PREFIX.length, raw.length);
            return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
        } catch (Exception ex) {
            throw new IllegalStateException("cannot build Ed25519 private key", ex);
        }
    }

    public static PublicKey publicKeyFromRaw(byte[] raw) {
        try {
            byte[] x509 = new byte[X509_ED25519_PREFIX.length + raw.length];
            System.arraycopy(X509_ED25519_PREFIX, 0, x509, 0, X509_ED25519_PREFIX.length);
            System.arraycopy(raw, 0, x509, X509_ED25519_PREFIX.length, raw.length);
            return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(x509));
        } catch (Exception ex) {
            throw new IllegalStateException("cannot build Ed25519 public key", ex);
        }
    }

    public static byte[] decodeBase64(String base64) {
        byte[] raw = Base64.getDecoder().decode(base64 == null ? "" : base64.trim());
        if (raw.length != 32) throw new IllegalArgumentException("Ed25519 key must decode to 32 bytes");
        return Arrays.copyOf(raw, raw.length);
    }
}
