import React, { useEffect, useMemo, useState } from "react";
import { graphql, usePaginationFragment } from "react-relay";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { css } from "@emotion/react";

import { Icon, Icons } from "@arizeai/components";

import { Link } from "@phoenix/components/Link";
import { IntCell } from "@phoenix/components/table/IntCell";
import { tableCSS } from "@phoenix/components/table/styles";
import { TextCell } from "@phoenix/components/table/TextCell";
import { TimestampCell } from "@phoenix/components/table/TimestampCell";
import { SpanKindLabel } from "@phoenix/components/trace/SpanKindLabel";
import { formatFloat } from "@phoenix/utils/numberFormatUtils";

import { SpansTable_spans$key } from "./__generated__/SpansTable_spans.graphql";
import {
  SpanSort,
  SpansTableSpansQuery,
} from "./__generated__/SpansTableSpansQuery.graphql";
type SpansTableProps = {
  query: SpansTable_spans$key;
};

const floatRightCSS = css`
  float: right;
`;
const PAGE_SIZE = 100;
const DEFAULT_SORT: SpanSort = {
  col: "startTime",
  dir: "desc",
};
export function SpansTable(props: SpansTableProps) {
  //we need a reference to the scrolling element for logic down below
  const tableContainerRef = React.useRef<HTMLDivElement>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const { data, loadNext, hasNext, isLoadingNext, refetch } =
    usePaginationFragment<SpansTableSpansQuery, SpansTable_spans$key>(
      graphql`
        fragment SpansTable_spans on Query
        @refetchable(queryName: "SpansTableSpansQuery")
        @argumentDefinitions(
          after: { type: "String", defaultValue: null }
          first: { type: "Int", defaultValue: 100 }
          sort: {
            type: "SpanSort"
            defaultValue: { col: startTime, dir: desc }
          }
        ) {
          spans(first: $first, after: $after, sort: $sort)
            @connection(key: "SpansTable_spans") {
            edges {
              span: node {
                spanKind
                name
                startTime
                latencyMs
                tokenCountTotal
                context {
                  spanId
                  traceId
                }
                input {
                  value
                  mimeType
                }
                output {
                  value
                  mimeType
                }
              }
            }
          }
        }
      `,
      props.query
    );

  const tableData = useMemo(() => {
    const tableData = data.spans.edges.map(({ span }) => {
      // Normalize the data
      return {
        ...span,
        trace_id: span.context.traceId,
        span_id: span.context.spanId,
        inputValue: span.input.value,
        outputValue: span.output.value,
      };
    });

    return tableData;
  }, [data]);
  type TableRow = (typeof tableData)[number];
  const columns: ColumnDef<TableRow>[] = [
    {
      header: "start time",
      accessorKey: "startTime",
      cell: TimestampCell,
    },
    {
      header: "kind",
      accessorKey: "spanKind",
      enableSorting: false,
      cell: ({ getValue }) => {
        return <SpanKindLabel spanKind={getValue() as string} />;
      },
    },
    {
      header: "name",
      accessorKey: "name",
      enableSorting: false,
      cell: ({ getValue, row }) => {
        const { spanId, traceId } = row.original.context;
        return (
          <Link to={`/tracing/traces/${traceId}?selectedSpanId=${spanId}`}>
            {getValue() as string}
          </Link>
        );
      },
    },
    {
      header: "latency",
      accessorKey: "latencyMs",

      cell: ({ getValue }) => {
        const seconds = (getValue() as number) / 1000;
        return <span css={floatRightCSS}>{formatFloat(seconds)}s</span>;
      },
    },
    {
      header: "total tokens",
      accessorKey: "tokenCountTotal",
      cell: IntCell,
    },
    {
      header: "input",
      accessorKey: "inputValue",
      cell: TextCell,
      enableSorting: false,
    },
    {
      header: "output",
      accessorKey: "outputValue",
      cell: TextCell,
      enableSorting: false,
    },
  ];

  useEffect(() => {
    //if the sorting changes, we need to reset the pagination
    const sort = sorting[0];
    refetch({
      sort: sort
        ? {
            col: sort.id as SpanSort["col"],
            dir: sort.desc ? "desc" : "asc",
          }
        : DEFAULT_SORT,
      after: null,
      first: PAGE_SIZE,
    });
  }, [sorting, refetch]);
  const fetchMoreOnBottomReached = React.useCallback(
    (containerRefElement?: HTMLDivElement | null) => {
      if (containerRefElement) {
        const { scrollHeight, scrollTop, clientHeight } = containerRefElement;
        //once the user has scrolled within 300px of the bottom of the table, fetch more data if there is any
        if (
          scrollHeight - scrollTop - clientHeight < 300 &&
          !isLoadingNext &&
          hasNext
        ) {
          loadNext(PAGE_SIZE);
        }
      }
    },
    [hasNext, isLoadingNext, loadNext]
  );
  const table = useReactTable<TableRow>({
    columns,
    data: tableData,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const rows = table.getRowModel().rows;
  return (
    <div
      css={css`
        flex: 1 1 auto;
        overflow: auto;
      `}
      onScroll={(e) => fetchMoreOnBottomReached(e.target as HTMLDivElement)}
      ref={tableContainerRef}
    >
      <table css={tableCSS}>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th colSpan={header.colSpan} key={header.id}>
                  {header.isPlaceholder ? null : (
                    <div
                      {...{
                        className: header.column.getCanSort()
                          ? "cursor-pointer"
                          : "",
                        onClick: header.column.getToggleSortingHandler(),
                      }}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                      {header.column.getIsSorted() ? (
                        <Icon
                          className="sort-icon"
                          svg={
                            header.column.getIsSorted() === "asc" ? (
                              <Icons.ArrowUpFilled />
                            ) : (
                              <Icons.ArrowDownFilled />
                            )
                          }
                        />
                      ) : null}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row) => {
            return (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => {
                  return (
                    <td key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
