export type MockFile = {
  path: string;
  title: string;
  language: string;
  content: string;
};

export const mockFiles: MockFile[] = [
  {
    path: 'pom.xml',
    title: 'pom.xml',
    language: 'xml',
    content: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>demo</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
</project>
`,
  },
  {
    path: 'src/main/java/demo/App.java',
    title: 'App.java',
    language: 'java',
    content: `package demo;

public class App {
  public static void main(String[] args) {
    System.out.println("Hello, POC4");
  }
}
`,
  },
  {
    path: 'src/test/java/demo/AppTest.java',
    title: 'AppTest.java',
    language: 'java',
    content: `package demo;

public class AppTest {
  public static void main(String[] args) {
    System.out.println("ok");
  }
}
`,
  },
];
