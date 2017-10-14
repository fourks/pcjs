---
layout: page
title: "Q51712: How to Use the Token Pasting Operator in Microsoft C"
permalink: /pubs/pc/reference/microsoft/kb/Q51712/
---

	Article: Q51712
	Product: Microsoft C
	Version(s): 5.10   | 5.10
	Operating System: MS-DOS | OS/2
	Flags: ENDUSER | S_QUICKC S_QUICKASM 2.00 2.01
	Last Modified: 15-MAR-1990
	
	The token pasting operator (##) is used to replace tokens within a
	preprocessor string. The (##) can be used to mark off the first
	portion of the string as a token, the last part of the string as a
	token, or the middle of a string as a portion. See the examples shown
	below.
	
	The token pasting operator cannot be the first or the last token in a
	preprocessor string (see Page 197 of the "Microsoft C Language
	Reference" manual for Version 5.10). The first example below (GLUE)
	demonstrates the use of the token pasting operator to concatenate two
	tokens. There is a replaceable token in front of the operator and one
	following the operator. The token pasting operator effectively divides
	the string into the two pieces.
	
	A more complex situation arises when using the token pasting operator
	to replace a token embedded within a string (for example,
	THIS_IS_A_size_TOKEN, where size could be replaced with either large
	or small); the token to be replaced must be surrounded by token
	pasting operators (##). This is necessary only when the token to be
	replaced is completely embedded in another string (see Example 2).
	Normally, the space character is used as one of the token markers,
	while the (##) marks the other end. Only in this specific case (an
	embedded token) is more than one token pasting operator needed.
	
	For more information, please see the ANSI Draft Proposal for the C
	programming language (Document Number X3J11/88-159, 7 December 1988),
	Page 93, or the "Microsoft C Language Reference" manual for Version
	5.10, Page 197.
	
	/*
	    PASTE.C: Demonstrates the use of the token pasting operator.
	*/
	/*
	    Example 1 definition.
	    This definition will replace the token "a" from the beginning
	    of the string and "b" from the tail of the string.
	*/
	
	#define GLUE(a,b) a##b
	
	/*
	   These are the defines for Example 2.
	   Calling print with either LARGE or SMALL will then change
	   the PRINT macro to call the proper PRINT_..._SIZE macro.
	*/
	#define PRINT_LARGE_SIZE(val) printf("The large size is %d\n",val)
	#define PRINT_SMALL_SIZE(val) printf("The small size is %d\n",val)
	#define PRINT(size,val) PRINT_##size##_SIZE(val)
	
	void main ( void )
	
	{
	    char *varsrc = "Hello!" ;
	    char *vardest = "      " ;
	
	/*
	    Example #1: Tokens at beginning and end of string
	*/
	
	    strcpy(GLUE(var,dest),GLUE(var,src)) ;
	    printf("%s\n", GLUE(var,dest)) ;
	
	/*
	    Example #2: Token embedded in string
	*/
	
	    PRINT(LARGE, 2) ; /* Calls the printf() for large sizes. */
	    PRINT(SMALL, 1) ; /* Calls the printf() for small sizes. */
	}
	
	The following is the corresponding .i (preprocessed file). This file
	can be generated by using -P option at compile time (cl -P paste.c).
	
	void main ( void )
	
	{
	    char *varsrc = "Hello!" ;
	    char *vardest = "      " ;
	
	    strcpy(vardest,varsrc) ;
	    printf("%s\n", vardest) ;
	
	    printf("The large size is %d\n",2) ;
	    printf("The small size is %d\n",1) ;
	}