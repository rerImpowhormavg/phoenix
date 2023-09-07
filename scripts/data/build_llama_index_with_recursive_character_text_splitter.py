"""
Builds a LlamaIndex knowledge base over the Arize documentation and persists to disk. This script
uses LangChain's RecursiveCharacterTextSplitter to chunk the documents.
"""

import argparse
import logging
import shutil
import sys
from functools import partial
from typing import List

from langchain.docstore.document import Document as LangChainDocument
from langchain.document_loaders import GitbookLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from llama_index import Document as LlamaIndexDocument
from llama_index import ServiceContext, VectorStoreIndex
from llama_index.embeddings import OpenAIEmbedding
from tiktoken import Encoding, encoding_for_model


def load_gitbook_docs(docs_url: str) -> List[LangChainDocument]:
    """Loads documents from a Gitbook URL.

    Args:
        docs_url (str): URL to Gitbook docs.

    Returns:
        List[LangChainDocument]: List of documents in LangChain format.
    """
    loader = GitbookLoader(
        docs_url,
        load_all_paths=True,
    )
    return loader.load()


def tiktoken_len(text: str, tokenizer: Encoding) -> int:
    """Returns the length of a text in tokens.

    Args:
        text (str): The text to tokenize and count.
        tokenizer (tiktoken.Encoding): The tokenizer.

    Returns:
        int: The number of tokens in the text.
    """

    tokens = tokenizer.encode(text, disallowed_special=())
    return len(tokens)


def chunk_docs(
    documents: List[LangChainDocument],
    tokenizer: Encoding,
    chunk_size: int = 400,
    chunk_overlap: int = 20,
) -> List[LangChainDocument]:
    """Chunks the documents.

    The chunking strategy used in this function is from the following notebook and accompanying
    video:

    - https://github.com/pinecone-io/examples/blob/master/generation/langchain/handbook/
      xx-langchain-chunking.ipynb
    - https://www.youtube.com/watch?v=eqOfr4AGLk8

    Args:
        documents (List[LangChainDocument]): A list of input documents.

        tokenizer (tiktoken.Encoding): The tokenizer used to count the number of tokens in a text.

        chunk_size (int, optional): The size of the chunks in tokens.

        chunk_overlap (int, optional): The chunk overlap in tokens.

    Returns:
        List[LangChainDocument]: The chunked documents.
    """

    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        length_function=partial(tiktoken_len, tokenizer=tokenizer),
        separators=["\n\n", "\n", " ", ""],
    )
    return text_splitter.split_documents(documents)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)

    parser = argparse.ArgumentParser()
    parser.add_argument("--index-path", type=str, required=True, help="Path to persist index.")
    args = parser.parse_args()

    docs_url = "https://docs.arize.com/arize/"
    embedding_model_name = "text-embedding-ada-002"
    langchain_documents = load_gitbook_docs(docs_url)
    chunked_langchain_documents = chunk_docs(
        langchain_documents,
        tokenizer=encoding_for_model(embedding_model_name),
    )
    chunked_llama_index_documents = [
        LlamaIndexDocument.from_langchain_format(document)
        for document in chunked_langchain_documents
    ]
    embedding_model = OpenAIEmbedding(model=embedding_model_name)  # type: ignore
    index = VectorStoreIndex.from_documents(
        chunked_llama_index_documents,
        service_context=ServiceContext.from_defaults(embed_model=embedding_model),
    )

    shutil.rmtree(args.index_path, ignore_errors=True)
    index.storage_context.persist(args.index_path)
