const { expect } = require("chai");
const {
  createConversationFile,
  createConversationMetadataFile,
  createMessageFile,
  createSearchIndexDeltaFile,
  generateKeywords,
} = require("../src/formatters");

describe("formatters", function () {
  const now = Date.now();

  describe("createConversationFile", () => {
    it("should create a basic conversation file", () => {
      const file = createConversationFile({
        id: "conv_123",
        ownerAddress: "0xabc",
        createdAt: now,
        roflEncryptedKey: "0xkey",
      });
      expect(file).to.deep.equal({
        id: "conv_123",
        ownerAddress: "0xabc",
        createdAt: now,
        roflEncryptedKey: "0xkey",
      });
    });

    it("should create a branched conversation file", () => {
      const file = createConversationFile({
        id: "conv_456",
        ownerAddress: "0xabc",
        createdAt: now,
        roflEncryptedKey: "0xkey",
        branchedFromConversationId: "conv_123",
        branchedAtMessageId: "msg_789",
      });
      expect(file).to.have.property("branchedFromConversationId", "conv_123");
      expect(file).to.have.property("branchedAtMessageId", "msg_789");
    });
  });

  describe("createConversationMetadataFile", () => {
    it("should create a standard metadata file", () => {
      const file = createConversationMetadataFile({
        title: "Test Title",
        isDeleted: false,
        lastUpdatedAt: now,
      });
      expect(file).to.deep.equal({
        title: "Test Title",
        isDeleted: false,
        lastUpdatedAt: now,
      });
    });
  });

  describe("createMessageFile", () => {
    it("should create a user message file correctly", () => {
      const file = createMessageFile({
        id: "msg_1",
        conversationId: "conv_1",
        parentId: null,
        parentCID: null,
        createdAt: now,
        role: "user",
        content: "Hello AI",
      });
      expect(file).to.deep.equal({
        id: "msg_1",
        conversationId: "conv_1",
        parentId: null,
        parentCID: null,
        createdAt: now,
        role: "user",
        content: "Hello AI",
      });
      // Ensure AI-specific fields are not present
      expect(file).to.not.have.property("sources");
      expect(file).to.not.have.property("reasoning");
    });

    it("should create an assistant message file correctly", () => {
      const sources = [{ title: "Test", url: "http://test.com" }];
      const file = createMessageFile({
        id: "msg_2",
        conversationId: "conv_1",
        parentId: "msg_1",
        parentCID: "cid_1",
        createdAt: now + 1,
        role: "assistant",
        content: "Hello User",
        sources,
        reasoningDuration: 5,
      });
      expect(file).to.deep.equal({
        id: "msg_2",
        conversationId: "conv_1",
        parentId: "msg_1",
        parentCID: "cid_1",
        createdAt: now + 1,
        role: "assistant",
        content: "Hello User",
        sources,
        reasoning: [],
        reasoningDuration: 5,
      });
    });
  });

  describe("generateKeywords", () => {
    it("should process and remove stopwords from a string", () => {
      const content = "This is a test of the keyword generation, it should work.";
      const keywords = generateKeywords(content);
      expect(keywords).to.equal("test keyword generation work");
    });

    it("should handle punctuation and extra spacing", () => {
      const content = "  Hello, world!    This is-a-test...  ";
      const keywords = generateKeywords(content);
      expect(keywords).to.equal("hello world test");
    });

    it("should return an empty string for empty or stopword-only input", () => {
      expect(generateKeywords("")).to.equal("");
      expect(generateKeywords("the a is of")).to.equal("");
    });
  });

  describe("createSearchIndexDeltaFile", () => {
    it("should create a correctly structured search delta object", () => {
      const file = createSearchIndexDeltaFile({
        conversationId: "conv_123",
        messageId: "msg_456",
        userMessageContent: "A test for the search index.",
      });
      expect(file).to.deep.equal({
        msg_456: {
          cid: "conv_123",
          c: "test search index",
        },
      });
    });
  });
});
