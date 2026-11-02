-- V18: serialization points for the challenge allocation quotas (design section 5.3).
-- Each named row is locked FOR UPDATE while the corresponding short transaction allocates
-- capacity: 'captcha' serializes the active-CAPTCHA count+insert (a plain COUNT-then-INSERT is
-- not an atomic constraint) and 'email_send_slot' serializes email send-slot reservation so a
-- concurrent first reservation of the same slot cannot deadlock on the unique key. Additive only:
-- no existing table or row is modified; capacity is still released by the opportunistic cleanup.
CREATE TABLE auth_challenge_allocation (
    name VARCHAR(32) NOT NULL,
    PRIMARY KEY (name)
) ENGINE=InnoDB;

INSERT INTO auth_challenge_allocation(name) VALUES ('captcha'), ('email_send_slot');
