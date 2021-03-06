/**
 * @license
 * Copyright 2016 Palantir Technologies, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as utils from "tsutils";
import * as ts from "typescript";
import * as Lint from "../index";
import { isAssignment, unwrapParentheses } from "../language/utils";

export class Rule extends Lint.Rules.AbstractRule {
    /* tslint:disable:object-literal-sort-keys */
    public static metadata: Lint.IRuleMetadata = {
        ruleName: "prefer-for-of",
        description: "Recommends a 'for-of' loop over a standard 'for' loop if the index is only used to access the array being iterated.",
        rationale: "A for(... of ...) loop is easier to implement and read when the index is not needed.",
        optionsDescription: "Not configurable.",
        options: null,
        optionExamples: ["true"],
        type: "typescript",
        typescriptOnly: false,
    };
    /* tslint:enable:object-literal-sort-keys */

    public static FAILURE_STRING = "Expected a 'for-of' loop instead of a 'for' loop with this simple iteration";

    public apply(sourceFile: ts.SourceFile): Lint.RuleFailure[] {
        return this.applyWithFunction(sourceFile, walk);
    }
}

interface IncrementorState {
    indexVariableName: string;
    arrayExpr: ts.Expression;
    onlyArrayReadAccess: boolean;
}

function walk(ctx: Lint.WalkContext<void>): void {
    const scopes: IncrementorState[] = [];

    return ts.forEachChild(ctx.sourceFile, cb);

    function cb(node: ts.Node): void {
        switch (node.kind) {
            case ts.SyntaxKind.ForStatement:
                return visitForStatement(node as ts.ForStatement);
            case ts.SyntaxKind.Identifier:
                return visitIdentifier(node as ts.Identifier);
            default:
                return ts.forEachChild(node, cb);
        }
    }

    function visitForStatement(node: ts.ForStatement): void {
        const arrayNodeInfo = getForLoopHeaderInfo(node);
        if (!arrayNodeInfo) {
            return ts.forEachChild(node, cb);
        }

        const { indexVariable, arrayExpr } = arrayNodeInfo;
        const indexVariableName = indexVariable.text;

        // store `for` loop state
        const state: IncrementorState = { indexVariableName, arrayExpr, onlyArrayReadAccess: true };
        scopes.push(state);
        ts.forEachChild(node.statement, cb);
        scopes.pop();

        if (state.onlyArrayReadAccess) {
            ctx.addFailure(node.getStart(), node.statement.getFullStart(), Rule.FAILURE_STRING);
        }
    }

    function visitIdentifier(node: ts.Identifier): void {
        const state = getStateForVariable(node.text);
        if (state) {
            updateIncrementorState(node, state);
        }
    }

    function getStateForVariable(name: string): IncrementorState | undefined {
        for (let i = scopes.length - 1; i >= 0; i--) {
            const scope = scopes[i];
            if (scope.indexVariableName === name) {
                return scope;
            }
        }
        return undefined;
    }
}

function updateIncrementorState(node: ts.Identifier, state: IncrementorState): void {
    // check if iterator is used for something other than reading data from array
    const elementAccess = node.parent!;
    if (!utils.isElementAccessExpression(elementAccess)) {
        state.onlyArrayReadAccess = false;
        return;
    }

    const arrayExpr = unwrapParentheses(elementAccess.expression);
    if (state.arrayExpr.getText() !== arrayExpr.getText()) {
        // iterator used in array other than one iterated over
        state.onlyArrayReadAccess = false;
    } else if (isAssignment(elementAccess.parent!)) {
        // array position is assigned a new value
        state.onlyArrayReadAccess = false;
    }
}

// returns the iterator and array of a `for` loop if the `for` loop is basic.
function getForLoopHeaderInfo(forLoop: ts.ForStatement): { indexVariable: ts.Identifier, arrayExpr: ts.Expression } | undefined {
    const { initializer, condition, incrementor } = forLoop;
    if (!initializer || !condition || !incrementor) {
        return undefined;
    }

    // Must start with `var i = 0;` or `let i = 0;`
    if (!utils.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) {
        return undefined;
    }
    const { name: indexVariable, initializer: indexInit } = initializer.declarations[0];
    if (indexVariable.kind !== ts.SyntaxKind.Identifier || indexInit === undefined || !isNumber(indexInit, "0")) {
        return undefined;
    }

    // Must end with `i++`
    if (!isIncremented(incrementor, indexVariable.text)) {
        return undefined;
    }

    // Condition must be `i < arr.length;`
    if (!utils.isBinaryExpression(condition)) {
        return undefined;
    }

    const { left, operatorToken, right } = condition;
    if (!isIdentifierNamed(left, indexVariable.text) ||
            operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
            !utils.isPropertyAccessExpression(right)) {
        return undefined;
    }

    const { expression: arrayExpr, name } = right;
    if (name.text !== "length") {
        return undefined;
    }

    return { indexVariable, arrayExpr };
}

function isIncremented(node: ts.Node, indexVariableName: string): boolean {
    switch (node.kind) {
        case ts.SyntaxKind.PrefixUnaryExpression:
        case ts.SyntaxKind.PostfixUnaryExpression: {
            const { operator, operand } = node as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
            // `++x` or `x++`
            return operator === ts.SyntaxKind.PlusPlusToken && isVar(operand);
        }

        case ts.SyntaxKind.BinaryExpression:
            const { operatorToken, left: updatedVar, right: rhs } = node as ts.BinaryExpression;
            if (!isVar(updatedVar)) {
                return false;
            }

            switch (operatorToken.kind) {
                case ts.SyntaxKind.PlusEqualsToken:
                    // x += 1
                    return isOne(rhs);
                case ts.SyntaxKind.EqualsToken: {
                    if (!utils.isBinaryExpression(rhs)) {
                        return false;
                    }
                    const { operatorToken: rhsOp, left, right } = rhs;
                    // `x = 1 + x` or `x = x + 1`
                    return rhsOp.kind === ts.SyntaxKind.PlusToken && (isVar(left) && isOne(right) || isOne(left) && isVar(right));
                }
                default:
                    return false;
            }

        default:
            return false;
    }

    function isVar(id: ts.Node): boolean {
        return isIdentifierNamed(id, indexVariableName);
    }
}

function isIdentifierNamed(node: ts.Node, text: string): boolean {
    return utils.isIdentifier(node) && node.text === text;
}

function isOne(node: ts.Node): boolean {
    return isNumber(node, "1");
}

function isNumber(node: ts.Node, value: string): boolean {
    return utils.isNumericLiteral(node) && node.text === value;
}
