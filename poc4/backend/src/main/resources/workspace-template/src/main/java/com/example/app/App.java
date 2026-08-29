package com.example.app;

public final class App {
    public String greeting() {
        return "Hello from Manao";
    }

    public static void main(String[] args) {
        System.out.println(new App().greeting());
    }
}
