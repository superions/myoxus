# Structured footnotes

Parent reference[^Research], repeated reference[^research], numeric reference[^2]
and a legacy citation[^source].

[^Research]:
    Definition body with **bold**, _emphasis_, ~~strike~~, `inline code`
    and a [normal link](https://example.org/reference).

    Second paragraph with a soft
    break and a hard break.  
    Continued after the hard break.

    ### Definition heading

    3. Ordered item
       - Nested unordered item
       - [x] Completed task
       - [ ] Pending task

    > Quoted definition text.

    ```ts
    const source = "literal[^not-a-reference]";
    ```

    ![pixel](media/pixel.svg)

    | left | center | right |
    | :--- | :----: | ----: |
    | one  |  two   | three |

[^2]: A separate numeric definition.

[^source]: {"type":"url","url":"https%3A%2F%2Fexample.org","title":"Legacy citation"}
